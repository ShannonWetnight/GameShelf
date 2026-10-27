package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func wipeWithPIN(t *testing.T, cookie *http.Cookie, body any) *httptest.ResponseRecorder {
	t.Helper()
	token, _ := onePIN(t, cookie, resetAccessActions(), false)
	return profileTestCall(t, http.HandlerFunc(handleResetServerSettings), "POST", "/api/server-settings/reset", body, []*http.Cookie{cookie}, map[string]string{"X-GameShelf-PIN": token})
}

func TestGameOverRequiresFreshPINAndBothConfirmations(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, nil)
	familyUnlock(t, "7392", resetAccessActions(), cookie)
	body := map[string]any{"confirm": "WIPE", "acknowledgeBackup": true}
	if r := familyCall(t, handleResetServerSettings, "POST", "/api/server-settings/reset", body, cookie); r.Code != 423 {
		t.Fatal("remembered PIN authorized Wipe", r.Code)
	}
	for _, invalid := range []any{nil, map[string]any{"confirm": "WIPE"}, map[string]any{"confirm": "wipe", "acknowledgeBackup": true}} {
		if r := wipeWithPIN(t, cookie, invalid); r.Code != 400 {
			t.Fatal("confirmation skipped", r.Code, r.Body.String())
		}
	}
	if record, _ := readPINRecord(); record == nil {
		t.Fatal("failed confirmation deleted PIN")
	}
}

func TestGameOverClearsOwnedDataAndSessionsButPreservesOriginals(t *testing.T) {
	root, home := setupFreshServer(t)
	profile := createProfileForTest(t, "Jamie", []string{"child"})
	cookie := familyCreate(t, nil)
	profileLoginTest(t, profile.ID, nil)
	original := filepath.Join(root, "keep-game.txt")
	if err := os.WriteFile(original, []byte("original game"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".network-key", "library-state.json", "network-index.json", "library-health.json", "unrelated.txt"} {
		if err := os.WriteFile(filepath.Join(home, name), []byte("saved"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"covers", "network-covers"} {
		if err := os.MkdirAll(filepath.Join(home, name), 0700); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(home, name, "edited.png"), []byte("edited"), 0600)
	}
	applicationLogs.Write([]byte("old activity\n"))
	if r := wipeWithPIN(t, cookie, map[string]any{"confirm": "WIPE", "acknowledgeBackup": true}); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	for _, name := range []string{".family-pin.json", ".family-profiles.json", ".network-key", "library-state.json", "network-index.json", "library-health.json", "covers", "network-covers"} {
		if _, err := os.Lstat(filepath.Join(home, name)); !os.IsNotExist(err) {
			t.Fatal("owned state remains", name, err)
		}
	}
	if got, err := os.ReadFile(original); err != nil || string(got) != "original game" {
		t.Fatal("original changed", err)
	}
	if _, err := os.Stat(filepath.Join(home, "unrelated.txt")); err != nil {
		t.Fatal("unowned file removed", err)
	}
	if !setupRequired.Load() || configuredSettings.SetupStatus != "pending" || configuredSettings.Access != nil || len(profileSessions) != 0 || len(accessSessions) != 0 {
		t.Fatal("state was not reset")
	}
	if bytes.Contains(applicationLogs.Snapshot(), []byte("old activity")) {
		t.Fatal("old logs retained")
	}
	if record, err := readPINRecord(); err != nil || record != nil {
		t.Fatal("private PIN survived", err)
	}
}

func TestGameOverDoesNotFollowCoverSymlinks(t *testing.T) {
	_, home := setupFreshServer(t)
	cookie := familyCreate(t, nil)
	outside := t.TempDir()
	marker := filepath.Join(outside, "original.png")
	os.WriteFile(marker, []byte("keep"), 0600)
	if err := os.Symlink(outside, filepath.Join(home, "covers")); err != nil {
		t.Skip("symlinks unavailable", err)
	}
	if r := wipeWithPIN(t, cookie, map[string]any{"confirm": "WIPE", "acknowledgeBackup": true}); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if got, err := os.ReadFile(marker); err != nil || string(got) != "keep" {
		t.Fatal("followed symlink", err)
	}
}

func TestNavigationEventsDoNotRequireDisabledSettings(t *testing.T) {
	setupFreshServer(t)
	profile := createProfileForTest(t, "Jamie", []string{"child"})
	familyCreate(t, nil)
	enableProfilesForTest(t)
	cookie := profileLoginTest(t, profile.ID, nil)
	handler := profileGate(accessGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })))
	for _, body := range []map[string]string{{"view": "list"}, {"sort": "name"}, {"settings-level": "advanced"}} {
		if r := profileTestCall(t, handler, "POST", "/api/settings-events", body, []*http.Cookie{cookie}, nil); r.Code != 204 {
			t.Fatal("navigation classified as settings", r.Code, r.Body.String())
		}
	}
	if r := profileTestCall(t, handler, "POST", "/api/settings-events", map[string]string{"theme": "dark"}, []*http.Cookie{cookie}, nil); r.Code != 403 {
		t.Fatal("real setting bypassed gate", r.Code)
	}
}

func TestFreshPINPermitCannotBeReplayed(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, nil)
	token, _ := onePIN(t, cookie, []string{"wipe"}, true)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if checkFreshPIN(w, r, []string{"wipe"}) {
			w.WriteHeader(204)
		}
	})
	for i, want := range []int{204, 423} {
		got := profileTestCall(t, handler, "POST", "/", nil, []*http.Cookie{cookie}, map[string]string{"X-GameShelf-PIN": token})
		if got.Code != want {
			t.Fatal(i, got.Code, got.Body.String())
		}
	}
	reply := familyCall(t, handleAccess, "GET", "/api/access", nil, cookie)
	var public struct{ Grants map[string]string }
	json.Unmarshal(reply.Body.Bytes(), &public)
	if strings.Contains(reply.Body.String(), "7392") || public.Grants["wipe"] != "" {
		t.Fatal("fresh Wipe became remembered")
	}
}
