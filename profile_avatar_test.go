package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"strings"
	"testing"
)

func avatarJPEG(t *testing.T, width, height int) string {
	t.Helper()
	photo := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			photo.Set(x, y, color.RGBA{uint8(x), uint8(y), 130, 255})
		}
	}
	var data bytes.Buffer
	if err := jpeg.Encode(&data, photo, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data.Bytes())
}

func TestProfileAvatarValidationAndNormalization(t *testing.T) {
	valid := avatarJPEG(t, 256, 256)
	for _, value := range []string{"", "builtin:pixel-robot", valid} {
		if _, err := normalizeProfileAvatar(value); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"builtin:missing", "https://example.com/photo.jpg", "data:image/svg+xml,<svg/>", "data:image/jpeg;base64,???", avatarJPEG(t, 512, 256), avatarJPEG(t, 1, 1), "data:image/jpeg;base64," + strings.Repeat("A", 140000)} {
		if err := validateProfileAvatar(value); err == nil {
			t.Fatalf("invalid avatar accepted: %.60s", value)
		}
	}
	// Re-encoding strips arbitrary JPEG metadata rather than persisting uploads verbatim.
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(valid, "data:image/jpeg;base64,"))
	comment := []byte{0xff, 0xfe, 0, 12}
	comment = append(comment, []byte("secret-tag")...)
	tagged := append(append(append([]byte{}, raw[:2]...), comment...), raw[2:]...)
	normalized, err := normalizeProfileAvatar("data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(tagged))
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(normalized, "data:image/jpeg;base64,"))
	if bytes.Contains(decoded, []byte("secret-tag")) {
		t.Fatal("upload metadata retained")
	}
}

func TestProfileAvatarsPersistAndTravelInProtectedBackups(t *testing.T) {
	setupFreshServer(t)
	profile := createProfileForTest(t, "Photo", []string{"child"})
	profile.Avatar = avatarJPEG(t, 256, 256)
	save := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": profile}, nil)
	if save.Code != 200 {
		t.Fatal(save.Code, save.Body.String())
	}
	listed := familyCall(t, handleProfiles, "GET", "/api/profiles", nil, nil)
	var view struct{ Profiles []struct{ Avatar string } }
	if err := json.Unmarshal(listed.Body.Bytes(), &view); err != nil || len(view.Profiles) != 1 {
		t.Fatal(err, listed.Body.String())
	}
	normalized := view.Profiles[0].Avatar
	if validateProfileAvatar(normalized) != nil || normalized == "" {
		t.Fatal("photo missing from public picker")
	}
	key := base64.StdEncoding.EncodeToString([]byte("Aprofile photos backup passphrase7!"))
	data, err := encodeProfilesBackup(key)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(normalized)) {
		t.Fatal("photo escaped protected archive")
	}
	db, err := decodeProfilesBackup(data, key)
	if err != nil || db.Profiles[profile.ID].Avatar != normalized {
		t.Fatal("photo not restored", err)
	}
	before, err := os.ReadFile(profilePath())
	if err != nil {
		t.Fatal(err)
	}
	profile.Avatar = "data:image/svg+xml,<svg onload='alert(1)'/>"
	failed := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": profile}, nil)
	after, _ := os.ReadFile(profilePath())
	if failed.Code != 400 || !bytes.Equal(before, after) {
		t.Fatal("invalid photo altered saved profiles", failed.Code)
	}
	// Older clients which don't send an avatar preserve the existing photo.
	profile.Avatar = ""
	saved := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": profile}, nil)
	if saved.Code != 200 {
		t.Fatal(saved.Code, saved.Body.String())
	}
	profileMu.Lock()
	current, err := readProfileDBLocked()
	profileMu.Unlock()
	if err != nil || current.Profiles[profile.ID].Avatar != normalized {
		t.Fatal("legacy client dropped avatar", err)
	}
}
