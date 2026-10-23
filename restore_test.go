package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func restoreZIP(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for name, contents := range entries {
		member, err := archive.Create(name)
		if err != nil { t.Fatal(err) }
		if _, err := member.Write(contents); err != nil { t.Fatal(err) }
	}
	if err := archive.Close(); err != nil { t.Fatal(err) }
	return buffer.Bytes()
}

func restorePNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil { t.Fatal(err) }
	return buffer.Bytes()
}

func TestLibraryRestorePreviewAndApply(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil { t.Fatal(err) }
	state, err := readLibraryMetadata()
	if err != nil { t.Fatal(err) }
	state.Titles[filepath.Join(rootDir, "Alpha")] = "Restored Alpha"
	state.Favorites[filepath.Join(rootDir, "Alpha")] = true
	contents, err := json.Marshal(state)
	if err != nil { t.Fatal(err) }
	cover := restorePNG(t)
	backup := restoreZIP(t, map[string][]byte{"library-state.json": contents, "covers/Alpha/cover.png": cover, "logs.txt": []byte("old log")})
	preview := httptest.NewRecorder()
	handleLibraryRestore(preview, httptest.NewRequest(http.MethodPost, "/api/library-restore", bytes.NewReader(backup)))
	if preview.Code != http.StatusOK { t.Fatalf("preview: %d %s", preview.Code, preview.Body.String()) }
	var summary struct { SHA256 string `json:"sha256"`; State bool `json:"state"`; Covers int `json:"covers"`; LogsSkipped bool `json:"logsSkipped"` }
	if err := json.Unmarshal(preview.Body.Bytes(), &summary); err != nil { t.Fatal(err) }
	if !summary.State || summary.Covers != 1 || !summary.LogsSkipped { t.Fatalf("preview: %#v", summary) }
	if getGameEntryByID("alpha").Game.Name != "Alpha" { t.Fatal("preview changed live data") }
	apply := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/library-restore?apply=1&state=1&covers=1", bytes.NewReader(backup))
	request.Header.Set("X-Preview-SHA256", summary.SHA256)
	handleLibraryRestore(apply, request)
	if apply.Code != http.StatusOK { t.Fatalf("apply: %d %s", apply.Code, apply.Body.String()) }
	game := getGameEntryByID("alpha").Game
	if game.Name != "Restored Alpha" || !game.Favorite || game.CoverSource != "uploaded" { t.Fatalf("restored game: %#v", game) }
	actual, err := os.ReadFile(customCoverPath("Alpha"))
	if err != nil || !bytes.Equal(actual, cover) { t.Fatalf("restored cover: %v", err) }
}

func TestLibraryRestoreRejectsUnsafeArchiveAndChangedPreview(t *testing.T) {
	setupLibrary(t)
	for _, name := range []string{"../outside", "covers/../cover.png", "covers/Alpha/../../escape"} {
		backup := restoreZIP(t, map[string][]byte{name: []byte("bad")})
		w := httptest.NewRecorder()
		handleLibraryRestore(w, httptest.NewRequest(http.MethodPost, "/api/library-restore", bytes.NewReader(backup)))
		if w.Code != http.StatusBadRequest { t.Fatalf("%q: status %d", name, w.Code) }
	}
	state := []byte(`{"version":1,"firstSeen":{}}`)
	backup := restoreZIP(t, map[string][]byte{"library-state.json": state})
	w := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/library-restore?apply=1&state=1", bytes.NewReader(backup))
	request.Header.Set("X-Preview-SHA256", strings.Repeat("0", 64))
	handleLibraryRestore(w, request)
	if w.Code != http.StatusConflict { t.Fatalf("stale preview: status %d", w.Code) }
	digest := sha256.Sum256(backup)
	if hex.EncodeToString(digest[:]) == strings.Repeat("0", 64) { t.Fatal("invalid test digest") }
}

func TestLibraryRestoreRejectsSymlinkedCoverStorage(t *testing.T) {
	setupLibrary(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dataDir, "covers")); err != nil { t.Skipf("symlinks unavailable: %v", err) }
	backup := restoreZIP(t, map[string][]byte{"covers/Alpha/cover.png": restorePNG(t)})
	digest := sha256.Sum256(backup)
	w := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/library-restore?apply=1&covers=1", bytes.NewReader(backup))
	request.Header.Set("X-Preview-SHA256", hex.EncodeToString(digest[:]))
	handleLibraryRestore(w, request)
	if w.Code != http.StatusServiceUnavailable { t.Fatalf("symlink storage: status %d", w.Code) }
	if _, err := os.Stat(filepath.Join(outside, "Alpha", "cover.png")); !os.IsNotExist(err) { t.Fatalf("wrote outside storage: %v", err) }
}
