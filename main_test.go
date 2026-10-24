package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Tests share the production globals and deliberately do not run in parallel.
func setupLibrary(t *testing.T) string {
	t.Helper()
	previousRoot, previousRoots, previousData, previousGames := rootDir, rootDirs, dataDir, gamesMap
	previousIndexedAt := lastIndexedAt
	t.Cleanup(func() {
		rootDir, rootDirs, dataDir, gamesMap, lastIndexedAt = previousRoot, previousRoots, previousData, previousGames, previousIndexedAt
	})
	rootDir = t.TempDir()
	rootDirs = nil
	dataDir = t.TempDir()
	gamesMap = make(map[string]*gameEntry)
	lastIndexedAt = time.Time{}
	return rootDir
}

func TestMultipleLibrarySourcesKeepSameNamedGamesSeparate(t *testing.T) {
	primary := setupLibrary(t)
	writeGame(t, "Alpha")
	secondary := t.TempDir()
	if err := os.Mkdir(filepath.Join(secondary, "Alpha"), 0755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(secondary, "Alpha", "game.txt"), []byte("second source"), 0644); err != nil { t.Fatal(err) }
	rootDirs = []string{primary, secondary}
	if err := refreshGames(); err != nil { t.Fatal(err) }
	if len(gamesMap) != 2 { t.Fatalf("indexed %d games, want 2", len(gamesMap)) }
	var first, second *gameEntry
	for _, entry := range gamesMap {
		if entry.RootDir == primary { first = entry } else if entry.RootDir == secondary { second = entry }
	}
	if first == nil || second == nil || first.Game.ID == second.Game.ID || first.CoverKey == second.CoverKey { t.Fatalf("sources collided: %#v %#v", first, second) }
	if first.Game.ID != "alpha" { t.Fatalf("primary ID changed: %q", first.Game.ID) }
	w := httptest.NewRecorder()
	handleDownload(w, httptest.NewRequest(http.MethodGet, "/download/"+second.Game.ID, nil))
	if w.Code != http.StatusOK { t.Fatalf("secondary download status %d: %s", w.Code, w.Body.String()) }
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil { t.Fatal(err) }
	if len(archive.File) != 1 { t.Fatalf("secondary archive has %d files", len(archive.File)) }
	file, err := archive.File[0].Open()
	if err != nil { t.Fatal(err) }
	contents, err := io.ReadAll(file)
	file.Close()
	if err != nil || string(contents) != "second source" { t.Fatalf("wrong source contents: %q, %v", contents, err) }
}

func TestCoverSourceOnlyServesSupportedImagesWithinGame(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	file, err := os.Create(filepath.Join(rootDir, "Alpha", "candidate.png"))
	if err != nil { t.Fatal(err) }
	if err := png.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil { t.Fatal(err) }
	file.Close()
	if err := refreshGames(); err != nil { t.Fatal(err) }
	for _, test := range []struct { path string; status int }{
		{"candidate.png", http.StatusOK}, {"game.txt", http.StatusNotFound}, {"../candidate.png", http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		handleCoverSource(w, httptest.NewRequest(http.MethodGet, "/api/cover-source/alpha?path="+url.QueryEscape(test.path), nil))
		if w.Code != test.status { t.Errorf("%s: status %d, want %d", test.path, w.Code, test.status) }
	}
}

func writeGame(t *testing.T, name string) {
	t.Helper()
	dir := filepath.Join(rootDir, name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "game.txt"), []byte("game data"), 0644); err != nil {
		t.Fatal(err)
	}
}

func requestGames(t *testing.T, path string, status int) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	handleGames(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != status {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, status, w.Body.String())
	}
	return w
}

func decodeGames(t *testing.T, w *httptest.ResponseRecorder) []Game {
	t.Helper()
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	var games []Game
	if err := json.Unmarshal(w.Body.Bytes(), &games); err != nil {
		t.Fatal(err)
	}
	return games
}

func TestHandleVersion(t *testing.T) {
	previousVersion, previousChannel := buildVersion, buildChannel
	t.Cleanup(func() { buildVersion, buildChannel = previousVersion, previousChannel })
	buildVersion, buildChannel = "edge-20261019-16.1-abc123def456", "edge"
	w := httptest.NewRecorder()
	handleVersion(w, httptest.NewRequest(http.MethodGet, "/api/version", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("version status = %d, content type = %q", w.Code, w.Header().Get("Content-Type"))
	}
	var info struct {
		Version string `json:"version"`
		Channel string `json:"channel"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil || info.Version != buildVersion || info.Channel != buildChannel {
		t.Fatalf("version response = %#v (%v)", info, err)
	}
	w = httptest.NewRecorder()
	handleVersion(w, httptest.NewRequest(http.MethodPost, "/api/version", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", w.Code)
	}
}

func TestHandleStatsSummarizesSuccessfulScan(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	writeGame(t, "Beta")
	if err := os.WriteFile(filepath.Join(rootDir, "Beta", "cover.png"), []byte("cover"), 0644); err != nil {
		t.Fatal(err)
	}
	before := time.Now().UTC().Add(-time.Second)
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleStats(w, httptest.NewRequest(http.MethodGet, "/api/stats", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("stats status = %d, content type = %q", w.Code, w.Header().Get("Content-Type"))
	}
	var stats LibraryStats
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats.GameCount != 2 || stats.FileCount != 3 || stats.TotalSizeBytes != 23 || stats.CoveredGameCount != 1 {
		t.Fatalf("unexpected stats: %#v", stats)
	}
	indexedAt, err := time.Parse(time.RFC3339, stats.LastIndexedAt)
	if err != nil || indexedAt.Before(before) {
		t.Fatalf("last indexed at = %q (%v)", stats.LastIndexedAt, err)
	}
	w = httptest.NewRecorder()
	handleStats(w, httptest.NewRequest(http.MethodPost, "/api/stats", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", w.Code)
	}
}

func TestFavoritePersistsAcrossScan(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil { t.Fatal(err) }
	w := httptest.NewRecorder()
	handleFavorite(w, httptest.NewRequest(http.MethodPut, "/api/favorite/alpha", strings.NewReader(`{"favorite":true}`)))
	if w.Code != http.StatusOK { t.Fatalf("favorite status = %d: %s", w.Code, w.Body.String()) }
	if err := refreshGames(); err != nil { t.Fatal(err) }
	if !getGameEntryByID("alpha").Game.Favorite { t.Fatal("favorite lost after scan") }
	w = httptest.NewRecorder()
	handleFavorite(w, httptest.NewRequest(http.MethodPut, "/api/favorite/alpha", strings.NewReader(`{"favorite":false}`)))
	if w.Code != http.StatusOK || getGameEntryByID("alpha").Game.Favorite { t.Fatal("favorite not removed") }
}

func TestMetadataResetRestoresFolderTitleCoverAndFavorite(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := os.WriteFile(filepath.Join(rootDir, "Alpha", "cover.jpg"), []byte("folder artwork"), 0644); err != nil { t.Fatal(err) }
	if err := refreshGames(); err != nil { t.Fatal(err) }
	firstSeen := getGameEntryByID("alpha").Game.AddedAt
	state, err := readLibraryMetadata()
	if err != nil { t.Fatal(err) }
	gamePath := filepath.Join(rootDir, "Alpha")
	state.Titles[gamePath] = "Custom Alpha"
	state.Favorites[gamePath] = true
	if err := writeLibraryMetadata(state); err != nil { t.Fatal(err) }
	cover := customCoverPath("Alpha")
	if err := os.MkdirAll(filepath.Dir(cover), 0700); err != nil { t.Fatal(err) }
	if err := os.WriteFile(cover, []byte("uploaded artwork"), 0600); err != nil { t.Fatal(err) }
	if err := refreshGames(); err != nil { t.Fatal(err) }
	w := httptest.NewRecorder()
	handleMetadataReset(w, httptest.NewRequest(http.MethodPut, "/api/metadata-reset/alpha", strings.NewReader(`{"title":true,"cover":true,"favorite":true}`)))
	if w.Code != http.StatusOK { t.Fatalf("reset status = %d: %s", w.Code, w.Body.String()) }
	game := getGameEntryByID("alpha").Game
	if game.Name != "Alpha" || game.Favorite || game.CoverSource != "folder" || game.AddedAt != firstSeen { t.Fatalf("reset game = %#v", game) }
	if _, err := os.Stat(cover); !os.IsNotExist(err) { t.Fatalf("uploaded cover still exists: %v", err) }
	if err := refreshGames(); err != nil { t.Fatal(err) }
	if got := getGameEntryByID("alpha").Game; got.Name != "Alpha" || got.Favorite || got.CoverSource != "folder" { t.Fatalf("scan lost reset: %#v", got) }
}

func TestBackupCanSelectLogsAndServerSettings(t *testing.T) {
	setupLibrary(t)
	previous := configuredSettings
	t.Cleanup(func() { configuredSettings = previous })
	configuredSettings = serverSettings{RootDir: rootDir, DataDir: dataDir, RefreshInterval: "1h", Verbose: true}
	applicationLogs.Write([]byte("backup log marker\n"))
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup?select=1&logs=1&settings=1", nil))
	if w.Code != http.StatusOK { t.Fatalf("backup status = %d: %s", w.Code, w.Body.String()) }
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil { t.Fatal(err) }
	if len(archive.File) != 2 || archive.File[0].Name != "server-settings.json" || archive.File[1].Name != "logs.txt" { t.Fatalf("backup entries = %#v", archive.File) }
	reader, err := archive.File[1].Open()
	if err != nil { t.Fatal(err) }
	contents, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !bytes.Contains(contents, []byte("backup log marker")) { t.Fatalf("log export: %v", err) }
}

func TestSelectedBackupOmitsUnselectedItems(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	writeGame(t, "Beta")
	if err := os.WriteFile(filepath.Join(rootDir, "Alpha", "cover.png"), []byte("alpha cover"), 0644); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(rootDir, "Beta", "cover.png"), []byte("beta cover"), 0644); err != nil { t.Fatal(err) }
	if err := refreshGames(); err != nil { t.Fatal(err) }
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup?select=1&cover=alpha", nil))
	if w.Code != http.StatusOK { t.Fatalf("selected backup status = %d: %s", w.Code, w.Body.String()) }
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil { t.Fatal(err) }
	if len(archive.File) != 1 || archive.File[0].Name != "folder-covers/Alpha/cover.png" { t.Fatalf("selected files = %#v", archive.File) }
}

func TestLibraryBackupExportsSavedDates(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("backup status = %d, content type = %q", w.Code, w.Header().Get("Content-Type"))
	}
	if got := w.Header().Get("Content-Disposition"); got != `attachment; filename="gameshelf-library-backup.zip"` {
		t.Fatalf("content disposition = %q", got)
	}
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 1 || archive.File[0].Name != "library-state.json" {
		t.Fatalf("backup files = %#v", archive.File)
	}
	stateFile, err := archive.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer stateFile.Close()
	var backup libraryState
	if err := json.NewDecoder(stateFile).Decode(&backup); err != nil {
		t.Fatal(err)
	}
	if backup.Version != 1 || backup.FirstSeen[filepath.Join(rootDir, "Alpha")] == "" {
		t.Fatalf("unexpected backup: %#v", backup)
	}
	w = httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodPost, "/api/library-backup", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", w.Code)
	}
}

func TestGameTitlePersistsAndExports(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil { t.Fatal(err) }
	w := httptest.NewRecorder()
	handleGameTitle(w, httptest.NewRequest(http.MethodPut, "/api/game-title/alpha", strings.NewReader(`{"title":"My Favorite"}`)))
	if w.Code != http.StatusOK || getGameEntryByID("alpha").Game.Name != "My Favorite" { t.Fatalf("save title: %d %s", w.Code, w.Body.String()) }
	if err := refreshGames(); err != nil { t.Fatal(err) }
	if getGameEntryByID("alpha").Game.Name != "My Favorite" { t.Fatal("refresh lost title") }
	w = httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil { t.Fatal(err) }
	file, err := archive.File[0].Open()
	if err != nil { t.Fatal(err) }
	defer file.Close()
	var state libraryState
	if err := json.NewDecoder(file).Decode(&state); err != nil { t.Fatal(err) }
	if state.Titles[filepath.Join(rootDir, "Alpha")] != "My Favorite" { t.Fatalf("backup titles: %#v", state.Titles) }
	w = httptest.NewRecorder()
	handleGameTitle(w, httptest.NewRequest(http.MethodPut, "/api/game-title/alpha", strings.NewReader(`{"title":""}`)))
	if w.Code != http.StatusOK || getGameEntryByID("alpha").Game.Name != "Alpha" { t.Fatalf("reset title: %d %s", w.Code, w.Body.String()) }
}

func TestUploadedCoverOverridesFolderArtAndIsBackedUp(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := os.WriteFile(filepath.Join(rootDir, "Alpha", "cover.png"), []byte("folder cover"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	image, err := os.ReadFile("web/placeholder.png")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/covers/alpha", bytes.NewReader(image))
	request.Header.Set("Content-Type", "image/png")
	w := httptest.NewRecorder()
	handleCoverUpload(w, request)
	if w.Code != http.StatusNoContent {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	if got := getGameEntryByID("alpha"); got.Game.CoverSource != "uploaded" || got.CoverPath != customCoverPath("Alpha") {
		t.Fatalf("cover entry = %#v", got)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if got := getGameEntryByID("alpha"); got.Game.CoverSource != "uploaded" {
		t.Fatalf("refresh lost custom cover: %#v", got)
	}
	w = httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 2 || archive.File[1].Name != "covers/Alpha/cover.png" {
		t.Fatalf("custom cover missing from backup: %#v", archive.File)
	}
	backupImage, err := archive.File[1].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer backupImage.Close()
	gotImage, err := io.ReadAll(backupImage)
	if err != nil || !bytes.Equal(gotImage, image) {
		t.Fatalf("backed up cover differs: %v", err)
	}
}

func TestCoverUploadRejectsInvalidImages(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		id, contentType string
		body []byte
		status int
	}{
		{"missing", "image/png", []byte("invalid"), http.StatusNotFound},
		{"alpha", "image/jpeg", []byte("invalid"), http.StatusUnsupportedMediaType},
		{"alpha", "image/png", []byte("invalid"), http.StatusBadRequest},
	} {
		request := httptest.NewRequest(http.MethodPut, "/api/covers/"+sample.id, bytes.NewReader(sample.body))
		request.Header.Set("Content-Type", sample.contentType)
		w := httptest.NewRecorder()
		handleCoverUpload(w, request)
		if w.Code != sample.status {
			t.Fatalf("%s upload = %d, want %d", sample.id, w.Code, sample.status)
		}
	}
}

func TestLibraryBackupRejectsInvalidState(t *testing.T) {
	setupLibrary(t)
	if err := os.WriteFile(filepath.Join(dataDir, "library-state.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Content-Disposition") != "" {
		t.Fatalf("invalid state backup = %d, headers %#v", w.Code, w.Header())
	}
}

func assertBackupFailed(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Content-Disposition") != "" || w.Header().Get("Content-Type") == "application/zip" {
		t.Fatalf("failed backup looks successful: status %d, headers %#v", w.Code, w.Header())
	}
	if !strings.Contains(w.Body.String(), "Library backup failed") || bytes.HasPrefix(w.Body.Bytes(), []byte("PK")) {
		t.Fatalf("expected actionable error, got %q", w.Body.String())
	}
}

func TestLibraryBackupRejectsUnavailableArtwork(t *testing.T) {
	for _, failure := range []string{"missing", "read-error", "permission-denied", "symlink-outside"} {
		t.Run(failure, func(t *testing.T) {
			setupLibrary(t)
			writeGame(t, "Alpha")
			cover := customCoverPath("Alpha")
			if err := os.MkdirAll(filepath.Dir(cover), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(cover, []byte("uploaded image"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(cover); err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "symlink-outside":
				secret := filepath.Join(t.TempDir(), "secret.png")
				if err := os.WriteFile(secret, []byte("private image"), 0600); err != nil {
					t.Fatal(err)
				}
				requireSymlink(t, secret, cover)
			case "read-error":
				// Opening a directory succeeds on Unix, but reading its bytes fails.
				// This exercises failure after ZIP generation has already started.
				if err := os.Mkdir(cover, 0700); err != nil {
					t.Fatal(err)
				}
			case "permission-denied":
				if err := os.WriteFile(cover, []byte("unreadable"), 0000); err != nil {
					t.Fatal(err)
				}
				if f, err := os.Open(cover); err == nil {
					f.Close()
					t.Skip("current identity bypasses file permissions; read-error case still exercises unreadable artwork")
				}
			}
			w := httptest.NewRecorder()
			handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
			assertBackupFailed(t, w)
			files, err := filepath.Glob(filepath.Join(dataDir, ".library-backup-*.zip"))
			if err != nil || len(files) != 0 {
				t.Fatalf("staged backup leaked: %v, %v", files, err)
			}
		})
	}
}

func TestLibraryBackupRejectsUnavailableTemporaryStorage(t *testing.T) {
	setupLibrary(t)
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	dataDir = blocked
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	assertBackupFailed(t, w)
}

func TestLibraryBackupRejectsReadOnlyStateStorage(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dataDir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dataDir, 0700) })
	if file, err := os.CreateTemp(dataDir, ".permission-probe-*"); err == nil {
		file.Close()
		os.Remove(file.Name())
		t.Skip("current identity bypasses directory write permissions")
	}
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	assertBackupFailed(t, w)
}

func TestLibraryBackupUsesDataVolumeWhenTemporaryDirectoryIsUnavailable(t *testing.T) {
	setupLibrary(t)
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", blocked)
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("export with unavailable /tmp: %d %s", w.Code, w.Body.String())
	}
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil || len(archive.File) != 1 || archive.File[0].Name != "library-state.json" {
		t.Fatalf("invalid empty backup: %v", err)
	}
	files, err := filepath.Glob(filepath.Join(dataDir, ".library-backup-*.zip"))
	if err != nil || len(files) != 0 {
		t.Fatalf("staged backup leaked: %v, %v", files, err)
	}
}

type backupFailWriter struct{ remaining int }

var errBackupWrite = errors.New("backup destination failed")

func (w *backupFailWriter) Write(p []byte) (int, error) {
	if len(p) > w.remaining {
		n := w.remaining
		w.remaining = 0
		return n, errBackupWrite
	}
	w.remaining -= len(p)
	return len(p), nil
}

func TestLibraryBackupPropagatesArchiveWriteAndFinalizationFailures(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	var complete bytes.Buffer
	if err := writeLibraryBackup(&complete); err != nil {
		t.Fatal(err)
	}
	// The final byte belongs to the ZIP end-of-central-directory record.
	for _, limit := range []int{0, 1, complete.Len() - 1} {
		if err := writeLibraryBackup(&backupFailWriter{remaining: limit}); !errors.Is(err, errBackupWrite) {
			t.Fatalf("write limit %d: got %v, want archive failure", limit, err)
		}
	}
}

type backupTransferFailure struct{ *httptest.ResponseRecorder }

func (w backupTransferFailure) Write(p []byte) (int, error) { return 0, errBackupWrite }

func TestLibraryBackupAbortsFailedTransferAndRemovesTemporaryFile(t *testing.T) {
	setupLibrary(t)
	defer func() {
		if got := recover(); got != http.ErrAbortHandler {
			t.Errorf("transfer failure panic = %v, want http.ErrAbortHandler", got)
		}
		files, err := filepath.Glob(filepath.Join(dataDir, ".library-backup-*.zip"))
		if err != nil || len(files) != 0 {
			t.Errorf("failed transfer leaked temporary file: %v, %v", files, err)
		}
	}()
	handleLibraryBackup(backupTransferFailure{httptest.NewRecorder()}, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
}

func TestLibraryBackupRestoresMetadataAndArtwork(t *testing.T) {
	setupLibrary(t)
	for _, name := range []string{"Alpha", "Legacy Game"} {
		writeGame(t, name)
	}
	image, err := os.ReadFile("web/placeholder.png")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "covers"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyCustomCoverPath("Legacy Game"), image, 0600); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/covers/alpha", bytes.NewReader(image))
	request.Header.Set("Content-Type", "image/png")
	w := httptest.NewRecorder()
	handleCoverUpload(w, request)
	if w.Code != http.StatusNoContent {
		t.Fatalf("upload failed: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	handleGameTitle(w, httptest.NewRequest(http.MethodPut, "/api/game-title/alpha", strings.NewReader(`{"title":"Custom Alpha"}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("title failed: %d", w.Code)
	}
	expectedState, err := readLibraryMetadata()
	if err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Length") != fmt.Sprint(w.Body.Len()) {
		t.Fatalf("backup response: %d, headers %#v", w.Code, w.Header())
	}
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{"library-state.json": true, "covers/Alpha/cover.png": true, "covers/Legacy Game/cover.png": true}
	// Follow the documented restore procedure into fresh /data storage while
	// retaining the same game mount path. Reading every member checks ZIP CRCs.
	originalDataDir := dataDir
	dataDir = t.TempDir()
	for _, member := range archive.File {
		if !expected[member.Name] {
			t.Fatalf("unexpected or duplicate member %q", member.Name)
		}
		delete(expected, member.Name)
		file, err := member.Open()
		if err != nil {
			t.Fatal(err)
		}
		contents, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if member.Name != "library-state.json" && !bytes.Equal(contents, image) {
			t.Fatal("artwork changed")
		}
		dest := filepath.Join(dataDir, filepath.FromSlash(member.Name))
		if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dest, contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if len(expected) != 0 {
		t.Fatalf("missing archive members: %v", expected)
	}
	gamesMap = make(map[string]*gameEntry)
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	restored, err := readLibraryMetadata()
	if err != nil || !reflect.DeepEqual(restored, expectedState) {
		t.Fatalf("restored state = %#v, want %#v (%v)", restored, expectedState, err)
	}
	for _, entry := range gamesMap {
		if entry.Game.AddedAt != expectedState.FirstSeen[entry.Game.Path] || entry.Game.CoverSource != "uploaded" {
			t.Fatalf("restored entry: %#v", entry)
		}
		if entry.DirName == "Alpha" && entry.Game.Name != "Custom Alpha" {
			t.Fatal("custom title not restored")
		}
		contents, err := os.ReadFile(entry.CoverPath)
		if err != nil || !bytes.Equal(contents, image) {
			t.Fatalf("restored cover differs: %v", err)
		}
		files, err := os.ReadDir(filepath.Join(rootDir, entry.DirName))
		if err != nil || len(files) != 1 || files[0].Name() != "game.txt" {
			t.Fatalf("game library modified: %v, %v", files, err)
		}
	}
	files, err := filepath.Glob(filepath.Join(originalDataDir, ".library-backup-*.zip"))
	if err != nil || len(files) != 0 {
		t.Fatalf("successful backup leaked temporary file: %v, %v", files, err)
	}
}

func TestLibraryBackupIncludesFolderCoversWithoutPlaceholders(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "With Cover")
	writeGame(t, "No Cover")
	cover := []byte("folder cover bytes")
	if err := os.WriteFile(filepath.Join(rootDir, "With Cover", "cover.jpg"), cover, 0644); err != nil { t.Fatal(err) }
	if err := refreshGames(); err != nil { t.Fatal(err) }
	w := httptest.NewRecorder()
	handleLibraryBackup(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	if w.Code != http.StatusOK { t.Fatalf("backup status = %d: %s", w.Code, w.Body.String()) }
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil { t.Fatal(err) }
	got := make(map[string]bool)
	for _, member := range archive.File {
		got[member.Name] = true
		if member.Name == "folder-covers/With Cover/cover.jpg" {
			f, err := member.Open()
			if err != nil { t.Fatal(err) }
			contents, err := io.ReadAll(f)
			f.Close()
			if err != nil || !bytes.Equal(contents, cover) { t.Fatalf("folder cover changed: %v", err) }
		}
	}
	if !got["folder-covers/With Cover/cover.jpg"] || !got["library-state.json"] || len(got) != 2 {
		t.Fatalf("unexpected archive contents: %v", got)
	}
}

func TestHandleGameFilesIsScopedToSelectedGame(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	writeGame(t, "Beta")
	if err := os.MkdirAll(filepath.Join(rootDir, "Alpha", "data"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "Alpha", "data", "save.dat"), []byte("save"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleGameFiles(w, httptest.NewRequest(http.MethodGet, "/api/game-files/alpha", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
	}
	var result struct {
		Files []gameFile `json:"files"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 0, len(result.Files))
	for _, file := range result.Files {
		paths = append(paths, file.Path)
	}
	if !reflect.DeepEqual(paths, []string{"data/save.dat", "game.txt"}) {
		t.Fatalf("files = %q", paths)
	}
	for _, request := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/api/game-files/missing", http.StatusNotFound},
		{http.MethodGet, "/api/game-files/alpha/other", http.StatusNotFound},
		{http.MethodPost, "/api/game-files/alpha", http.StatusMethodNotAllowed},
	} {
		w := httptest.NewRecorder()
		handleGameFiles(w, httptest.NewRequest(request.method, request.path, nil))
		if w.Code != request.status {
			t.Fatalf("%s %s status = %d, want %d", request.method, request.path, w.Code, request.status)
		}
	}
}

func TestIndividualFileDownloadStaysInsideSelectedGame(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	writeGame(t, "Beta")
	if err := os.MkdirAll(filepath.Join(rootDir, "Alpha", "data"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "Alpha", "data", "save.dat"), []byte("one file"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleGameFileDownload(w, httptest.NewRequest(http.MethodGet, "/api/game-file/alpha?path=data%2Fsave.dat", nil))
	if w.Code != http.StatusOK || w.Body.String() != "one file" || w.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("file download = %d, %q, %q", w.Code, w.Body.String(), w.Header().Get("Content-Type"))
	}
	for _, requestPath := range []string{
		"/api/game-file/alpha?path=..%2FBeta%2Fgame.txt",
		"/api/game-file/alpha?path=data",
		"/api/game-file/missing?path=game.txt",
	} {
		w := httptest.NewRecorder()
		handleGameFileDownload(w, httptest.NewRequest(http.MethodGet, requestPath, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d", requestPath, w.Code)
		}
	}
	if err := os.Symlink(filepath.Join(rootDir, "Beta", "game.txt"), filepath.Join(rootDir, "Alpha", "shortcut")); err == nil {
		w := httptest.NewRecorder()
		handleGameFileDownload(w, httptest.NewRequest(http.MethodGet, "/api/game-file/alpha?path=shortcut", nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("symlink download status = %d", w.Code)
		}
	}
}

func TestRefreshGamesReadDirFailurePreservesIndex(t *testing.T) {
	for _, kind := range []string{"missing", "file"} {
		t.Run(kind, func(t *testing.T) {
			root := setupLibrary(t)
			writeGame(t, "Existing Game")
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			before := getGameEntryByID("existing-game")
			rootDir = filepath.Join(root, "unavailable")
			if kind == "file" {
				if err := os.WriteFile(rootDir, nil, 0644); err != nil {
					t.Fatal(err)
				}
			}
			err := refreshGames()
			var pathErr *os.PathError
			if !errors.As(err, &pathErr) {
				t.Fatalf("expected wrapped filesystem error, got %v", err)
			}
			if len(gamesMap) != 1 || getGameEntryByID("existing-game") != before {
				t.Fatal("failed scan replaced existing index")
			}
			games := decodeGames(t, requestGames(t, "/api/games", http.StatusOK))
			if !reflect.DeepEqual(games, []Game{before.Game}) {
				t.Fatalf("cached response = %#v", games)
			}
		})
	}
}

func TestRefreshGamesSuccessfulRescans(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Old Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(rootDir, "Old Game")); err != nil {
		t.Fatal(err)
	}
	writeGame(t, "New Game")
	if err := os.WriteFile(filepath.Join(rootDir, "New Game", "cover.png"), []byte("cover"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	entry := getGameEntryByID("new-game")
	if len(gamesMap) != 1 || getGameEntryByID("old-game") != nil || entry == nil {
		t.Fatal("rescan did not replace index")
	}
	if entry.Game.Name != "New Game" || entry.Game.SizeBytes != 14 || !entry.Game.HasCover || entry.Game.FileCount != 2 || entry.Game.Path != filepath.Join(rootDir, "New Game") || entry.Game.AddedAt == "" || entry.CoverPath != filepath.Join(rootDir, "New Game", "cover.png") {
		t.Fatalf("entry = %#v", entry)
	}
	if err := os.RemoveAll(filepath.Join(rootDir, "New Game")); err != nil {
		t.Fatal(err)
	}
	w := requestGames(t, "/api/games?forceRefresh=1", http.StatusOK)
	if w.Body.String() != "[]\n" {
		t.Fatalf("empty library = %q", w.Body.String())
	}
}

func TestDateAddedPersistsOutsideReadOnlyLibrary(t *testing.T) {
	root := setupLibrary(t)
	writeGame(t, "First Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	first := getGameEntryByID("first-game").Game.AddedAt
	if _, err := time.Parse(time.RFC3339, first); err != nil {
		t.Fatalf("date added = %q: %v", first, err)
	}
	if _, err := os.Stat(filepath.Join(root, "library-state.json")); !os.IsNotExist(err) {
		t.Fatalf("state was written inside the game library: %v", err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if got := getGameEntryByID("first-game").Game.AddedAt; got != first {
		t.Fatalf("rescan changed first-seen date from %q to %q", first, got)
	}
	gamesMap = make(map[string]*gameEntry) // simulate a process restart
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if got := getGameEntryByID("first-game").Game.AddedAt; got != first {
		t.Fatalf("restart changed first-seen date from %q to %q", first, got)
	}
	writeGame(t, "Second Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	state, err := readLibraryState()
	if err != nil || len(state) != 2 || state[filepath.Join(root, "First Game")] != first {
		t.Fatalf("stored dates = %#v (%v)", state, err)
	}
	if err := os.RemoveAll(filepath.Join(root, "First Game")); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	state, err = readLibraryState()
	if err != nil || len(state) != 1 || state[filepath.Join(root, "First Game")] != "" {
		t.Fatalf("removed folder retained a first-seen date: %#v (%v)", state, err)
	}
}

func TestInvalidDateStateDoesNotHideGamesOrOverwriteState(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Game")
	statePath := filepath.Join(dataDir, "library-state.json")
	if err := os.WriteFile(statePath, []byte("invalid json"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if got := getGameEntryByID("game"); got == nil || got.Game.AddedAt != "" {
		t.Fatalf("game hidden or given an unpersisted date: %#v", got)
	}
	contents, err := os.ReadFile(statePath)
	if err != nil || string(contents) != "invalid json" {
		t.Fatalf("invalid state was overwritten: %q (%v)", contents, err)
	}
}

func TestHandleGamesForcedRefreshFailureAndRecovery(t *testing.T) {
	root := setupLibrary(t)
	writeGame(t, "Existing Game")
	initial := decodeGames(t, requestGames(t, "/api/games?forceRefresh=1", http.StatusOK))
	unavailable := root + "-offline"
	if err := os.Rename(root, unavailable); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(unavailable, root) })
	for i := 0; i < 2; i++ {
		w := requestGames(t, "/api/games?forceRefresh=1", http.StatusServiceUnavailable)
		if !strings.Contains(w.Body.String(), "Unable to refresh game library") || strings.Contains(w.Body.String(), root) {
			t.Fatalf("error body = %q", w.Body.String())
		}
		if got := decodeGames(t, requestGames(t, "/api/games", http.StatusOK)); !reflect.DeepEqual(got, initial) {
			t.Fatalf("lost cached library: %#v", got)
		}
	}
	if err := os.Rename(unavailable, root); err != nil {
		t.Fatal(err)
	}
	writeGame(t, "Added Game")
	if got := decodeGames(t, requestGames(t, "/api/games?forceRefresh=1", http.StatusOK)); len(got) != 2 {
		t.Fatalf("recovered library = %#v", got)
	}
}

func TestHandleGamesRejectsOtherMethods(t *testing.T) {
	setupLibrary(t)
	rootDir = filepath.Join(rootDir, "missing")
	w := httptest.NewRecorder()
	handleGames(w, httptest.NewRequest(http.MethodPost, "/api/games?forceRefresh=1", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestConcurrentRefreshesAndReads(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Existing Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := refreshGames(); err != nil {
				t.Error(err)
			}
			w := httptest.NewRecorder()
			handleGames(w, httptest.NewRequest(http.MethodGet, "/api/games", nil))
			var games []Game
			if err := json.Unmarshal(w.Body.Bytes(), &games); err != nil || w.Code != http.StatusOK || len(games) != 1 {
				t.Errorf("incomplete response: %s (%v)", w.Body.String(), err)
			}
		}()
	}
	wg.Wait()
}

func TestRefreshGamesChildReadFailurePreservesWholeIndex(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Existing Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	before := getGameEntryByID("existing-game")
	writeGame(t, "A New Game")
	writeGame(t, "Z Unreadable Game")
	blocked := filepath.Join(rootDir, "Z Unreadable Game")
	if err := os.Chmod(blocked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0755) })
	if _, err := os.ReadDir(blocked); err == nil {
		t.Skip("current user can read directories without permission; covered by Docker smoke test with DAC capabilities dropped")
	}
	if err := refreshGames(); err == nil {
		t.Fatal("expected child scan error")
	}
	if len(gamesMap) != 1 || getGameEntryByID("existing-game") != before {
		t.Fatal("failed child scan published a partial index")
	}
}

func requireSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
}

func zipContents(t *testing.T, body []byte) map[string]string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	result := make(map[string]string)
	for _, item := range reader.File {
		f, err := item.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		result[item.Name] = string(data)
	}
	return result
}

func TestZIPOmitsSymlinksAndKeepsOrdinaryFiles(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	writeGame(t, "Beta")
	outside := filepath.Join(rootDir, "Beta", "secret.txt")
	if err := os.WriteFile(outside, []byte("outside secret"), 0600); err != nil {
		t.Fatal(err)
	}
	game := filepath.Join(rootDir, "Alpha")
	requireSymlink(t, outside, filepath.Join(game, "leak.txt"))
	requireSymlink(t, "../Beta", filepath.Join(game, "other-game"))
	requireSymlink(t, "game.txt", filepath.Join(game, "internal-link"))
	requireSymlink(t, "missing", filepath.Join(game, "zz-broken"))
	if err := os.Mkdir(filepath.Join(game, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(game, "nested", "save.dat"), []byte("save"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleDownload(w, httptest.NewRequest(http.MethodGet, "/download/alpha", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ZIP status = %d", w.Code)
	}
	want := map[string]string{"game.txt": "game data", "nested/save.dat": "save"}
	if got := zipContents(t, w.Body.Bytes()); !reflect.DeepEqual(got, want) {
		t.Fatalf("ZIP contents = %#v", got)
	}
}

func TestCollidingGameIDsKeepZIPsInTheirOwnFolders(t *testing.T) {
	setupLibrary(t)
	secret := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(secret, []byte("outside secret"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Star Wars", "Star_Wars"} {
		writeGame(t, name)
		gameDir := filepath.Join(rootDir, name)
		if err := os.WriteFile(filepath.Join(gameDir, "game.txt"), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
		requireSymlink(t, secret, filepath.Join(gameDir, "leak.txt"))
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	ids := indexedIDs(t)
	if ids["Star Wars"] == ids["Star_Wars"] {
		t.Fatalf("colliding folders share an ID: %#v", ids)
	}
	for name, id := range ids {
		w := httptest.NewRecorder()
		handleDownload(w, httptest.NewRequest(http.MethodGet, "/download/"+id, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s ZIP status = %d", name, w.Code)
		}
		if got := zipContents(t, w.Body.Bytes()); !reflect.DeepEqual(got, map[string]string{"game.txt": name}) {
			t.Fatalf("%s ZIP contents = %#v", name, got)
		}
	}
}

func TestFolderCoverRejectsLinksAndNonregularFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "directory"} {
		t.Run(kind, func(t *testing.T) {
			setupLibrary(t)
			writeGame(t, "Alpha")
			cover := filepath.Join(rootDir, "Alpha", "cover.png")
			if kind == "symlink" {
				secret := filepath.Join(t.TempDir(), "secret.png")
				if err := os.WriteFile(secret, []byte("private image"), 0600); err != nil {
					t.Fatal(err)
				}
				requireSymlink(t, secret, cover)
			} else if err := os.Mkdir(cover, 0755); err != nil {
				t.Fatal(err)
			}
			if got := findCover(filepath.Dir(cover)); got != "" {
				t.Fatalf("unsafe cover selected: %q", got)
			}
			// A stale index must be revalidated at serving time too.
			gamesMap["alpha"] = &gameEntry{DirName: "Alpha", CoverPath: cover, Game: Game{CoverSource: "folder"}}
			w := httptest.NewRecorder()
			handleCover(w, httptest.NewRequest(http.MethodGet, "/covers/alpha", nil))
			if w.Code != http.StatusNotFound {
				t.Fatalf("unsafe cover status = %d", w.Code)
			}
		})
	}
}

func TestCoversRemainScopedAfterIndexing(t *testing.T) {
	for _, source := range []string{"folder", "uploaded", "legacy"} {
		t.Run(source, func(t *testing.T) {
			setupLibrary(t)
			writeGame(t, "Alpha")
			cover := filepath.Join(rootDir, "Alpha", "cover.png")
			if source == "uploaded" {
				cover = customCoverPath("Alpha")
			}
			if source == "legacy" {
				cover = legacyCustomCoverPath("Alpha")
			}
			if err := os.MkdirAll(filepath.Dir(cover), 0755); err != nil {
				t.Fatal(err)
			}
			image := []byte("ordinary cover image")
			if err := os.WriteFile(cover, image, 0644); err != nil {
				t.Fatal(err)
			}
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			handleCover(w, httptest.NewRequest(http.MethodGet, "/covers/alpha", nil))
			if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), image) {
				t.Fatalf("ordinary cover = %d, %q", w.Code, w.Body.String())
			}
			secret := filepath.Join(t.TempDir(), "secret.png")
			if err := os.WriteFile(secret, []byte("private image"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(cover); err != nil {
				t.Fatal(err)
			}
			requireSymlink(t, secret, cover)
			w = httptest.NewRecorder()
			handleCover(w, httptest.NewRequest(http.MethodGet, "/covers/alpha", nil))
			if w.Code != http.StatusNotFound || strings.Contains(w.Body.String(), "private image") {
				t.Fatalf("changed cover = %d, %q", w.Code, w.Body.String())
			}
		})
	}
}

func TestChangedGameDirectoryCannotExposeSibling(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	writeGame(t, "Beta")
	if err := os.WriteFile(filepath.Join(rootDir, "Alpha", "cover.png"), []byte("cover"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(rootDir, "Alpha"), filepath.Join(rootDir, "old-alpha")); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, "Beta", filepath.Join(rootDir, "Alpha"))
	for _, endpoint := range []struct {
		url     string
		handler http.HandlerFunc
		status  int
	}{
		{"/download/alpha", handleDownload, http.StatusServiceUnavailable},
		{"/api/game-file/alpha?path=game.txt", handleGameFileDownload, http.StatusNotFound},
		{"/covers/alpha", handleCover, http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		endpoint.handler(w, httptest.NewRequest(http.MethodGet, endpoint.url, nil))
		if w.Code != endpoint.status {
			t.Fatalf("%s = %d", endpoint.url, w.Code)
		}
	}
}

type mutationWriter struct {
	bytes.Buffer
	mutate func()
}

func (w *mutationWriter) Write(p []byte) (int, error) {
	if w.mutate != nil {
		fn := w.mutate
		w.mutate = nil
		fn()
	}
	return w.Buffer.Write(p)
}

func TestZIPUsesPinnedDirectoryDuringStreaming(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	root, err := openGameRoot(getGameEntryByID("alpha"))
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "game.txt"), []byte("outside secret"), 0600); err != nil {
		t.Fatal(err)
	}
	// Incompressible data forces ZIP output while files remain to be read.
	payload := make([]byte, 128*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "Alpha", "a-large.bin"), payload, 0644); err != nil {
		t.Fatal(err)
	}
	writer := &mutationWriter{mutate: func() {
		if err := os.Rename(filepath.Join(rootDir, "Alpha"), filepath.Join(rootDir, "moved")); err != nil {
			t.Fatal(err)
		}
		requireSymlink(t, outside, filepath.Join(rootDir, "Alpha"))
	}}
	if err := writeGameZIP(writer, root); err != nil {
		t.Fatal(err)
	}
	if got := zipContents(t, writer.Bytes()); !reflect.DeepEqual(got, map[string]string{"a-large.bin": string(payload), "game.txt": "game data"}) {
		t.Fatalf("ZIP after rename = %#v", got)
	}
}

func TestPinnedReadsRejectReplacedIntermediateDirectory(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	game := filepath.Join(rootDir, "Alpha")
	if err := os.Mkdir(filepath.Join(game, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(game)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(game, "nested"), filepath.Join(game, "old")); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, outside, filepath.Join(game, "nested"))
	file, _, err := openRegularFile(root, "nested/secret")
	if err == nil {
		file.Close()
		t.Fatal("opened a replaced directory")
	}
}

// Change a file after ZIP headers have reached the client, before its read.
type changingResponse struct {
	*httptest.ResponseRecorder
	mutate func()
}

func (w *changingResponse) Write(p []byte) (int, error) {
	if w.mutate != nil {
		fn := w.mutate
		w.mutate = nil
		fn()
	}
	return w.ResponseRecorder.Write(p)
}

func TestZIPAbortsWhenFileChangesDuringRequest(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	payload := make([]byte, 128*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	game := filepath.Join(rootDir, "Alpha")
	if err := os.WriteFile(filepath.Join(game, "a-large.bin"), payload, 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "private.txt")
	if err := os.WriteFile(outside, []byte("outside secret"), 0600); err != nil {
		t.Fatal(err)
	}
	w := &changingResponse{ResponseRecorder: httptest.NewRecorder(), mutate: func() {
		if err := os.Remove(filepath.Join(game, "game.txt")); err != nil {
			t.Fatal(err)
		}
		requireSymlink(t, outside, filepath.Join(game, "game.txt"))
	}}
	func() {
		defer func() {
			if got := recover(); got != http.ErrAbortHandler {
				t.Errorf("stream failure panic = %v", got)
			}
		}()
		handleDownload(w, httptest.NewRequest(http.MethodGet, "/download/alpha", nil))
		t.Error("changed file returned a successful archive")
	}()
	if bytes.Contains(w.Body.Bytes(), []byte("outside secret")) {
		t.Fatal("outside content leaked")
	}
	if _, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len())); err == nil {
		t.Fatal("partial ZIP was finalized")
	}
}

func TestOpenedFileSurvivesPathReplacement(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	root, err := os.OpenRoot(filepath.Join(rootDir, "Alpha"))
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	file, _, err := openRegularFile(root, "game.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	name := filepath.Join(rootDir, "Alpha", "game.txt")
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, outside, name)
	contents, err := io.ReadAll(file)
	if err != nil || string(contents) != "game data" {
		t.Fatalf("descriptor read = %q, %v", contents, err)
	}
}

func TestSpecialFilesAreNeverDownloaded(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	game := filepath.Join(rootDir, "Alpha")
	fifo := filepath.Join(game, "cover.png")
	if err := exec.Command("mkfifo", fifo).Run(); err != nil {
		t.Skipf("FIFO creation unavailable: %v", err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if gamesMap["alpha"].Game.HasCover {
		t.Fatal("FIFO selected as artwork")
	}
	w := httptest.NewRecorder()
	handleGameFileDownload(w, httptest.NewRequest(http.MethodGet, "/api/game-file/alpha?path=cover.png", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("FIFO download = %d", w.Code)
	}
	w = httptest.NewRecorder()
	handleDownload(w, httptest.NewRequest(http.MethodGet, "/download/alpha", nil))
	if got := zipContents(t, w.Body.Bytes()); !reflect.DeepEqual(got, map[string]string{"game.txt": "game data"}) {
		t.Fatalf("ZIP special files = %#v", got)
	}
}

func TestUploadedCoverRejectsReplacedParent(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	cover := customCoverPath("Alpha")
	if err := os.MkdirAll(filepath.Dir(cover), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cover, []byte("cover"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "cover.png"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Dir(cover), filepath.Join(dataDir, "old-cover")); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, outside, filepath.Dir(cover))
	w := httptest.NewRecorder()
	handleCover(w, httptest.NewRequest(http.MethodGet, "/covers/alpha", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("replaced uploaded parent = %d, %q", w.Code, w.Body.String())
	}
}

func TestMissingCoverUsesPlaceholder(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handleCover(w, httptest.NewRequest(http.MethodGet, "/covers/alpha", nil))
	image, err := webFS.ReadFile("web/placeholder.png")
	if err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || !bytes.Equal(image, w.Body.Bytes()) {
		t.Fatalf("placeholder = %d", w.Code)
	}
}

func indexedIDs(t *testing.T) map[string]string {
	t.Helper()
	result := make(map[string]string)
	for id, entry := range gamesMap {
		if id == "" || entry.Game.ID != id || result[entry.DirName] != "" {
			t.Fatalf("invalid indexed entry: %q %#v", id, entry)
		}
		result[entry.DirName] = id
	}
	return result
}

func TestCollidingGameIDsAreDistinctAndDeterministic(t *testing.T) {
	for _, names := range [][]string{
		{"Star Wars", "Star_Wars", "star-wars", "Star--Wars"},
		{"Alpha", "ALPHA", "alpha"},
		{"Pilot's", "Pilots", `Pilot"s`},
		{"---", "___", "'"},
	} {
		t.Run(strings.Join(names, ","), func(t *testing.T) {
			setupLibrary(t)
			for _, name := range names {
				writeGame(t, name)
			}
			writeGame(t, "Ordinary Game")
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			before := indexedIDs(t)
			if len(before) != len(names)+1 || before["Ordinary Game"] != "ordinary-game" {
				t.Fatalf("IDs = %#v", before)
			}
			for _, name := range names {
				if before[name] == "" {
					t.Fatalf("missing %q: %#v", name, before)
				}
			}
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(indexedIDs(t), before) {
				t.Fatal("rescan changed IDs")
			}
			restartIndex()
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(indexedIDs(t), before) {
				t.Fatal("restart changed IDs")
			}
			// Fresh state produces the same initial assignments, independent of creation order.
			dataDir = t.TempDir()
			rootDir = t.TempDir()
			writeGame(t, "Ordinary Game")
			for i := len(names) - 1; i >= 0; i-- {
				writeGame(t, names[i])
			}
			restartIndex()
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(indexedIDs(t), before) {
				t.Fatal("fresh scan changed deterministic IDs")
			}
		})
	}
}

func TestGameIDsSurviveCollisionGroupChanges(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Star Wars")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	first := indexedIDs(t)
	if first["Star Wars"] != "star-wars" {
		t.Fatal(first)
	}
	// Add a name that would win the old overwrite order.
	writeGame(t, "Star_Wars")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	both := indexedIDs(t)
	if len(both) != 2 || both["Star Wars"] != first["Star Wars"] || both["Star_Wars"] == "star-wars" {
		t.Fatal(both)
	}
	if err := os.RemoveAll(filepath.Join(rootDir, "Star Wars")); err != nil {
		t.Fatal(err)
	}
	gamesMap = make(map[string]*gameEntry)
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if getGameEntryByID("star-wars") != nil || indexedIDs(t)["Star_Wars"] != both["Star_Wars"] {
		t.Fatal("removed ID was reassigned")
	}
	writeGame(t, "Star Wars")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(indexedIDs(t), both) {
		t.Fatal("re-added folder lost its ID")
	}
}

func TestGeneratedGameIDCannotHideNaturalSlug(t *testing.T) {
	setupLibrary(t)
	hash := sha256.Sum256([]byte("Star Wars"))
	natural := fmt.Sprintf("star-wars-%x", hash)
	// Reserve a generated candidate from an absent folder as well as two
	// natural names with the same slug; every active folder must remain visible.
	state := libraryState{Version: 1, FirstSeen: map[string]string{}, IDs: map[string]string{"Absent": natural}}
	if err := writeLibraryMetadata(state); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Star Wars", "Star_Wars", natural, strings.ToUpper(natural)} {
		writeGame(t, name)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	ids := indexedIDs(t)
	if len(ids) != 4 || ids["Star Wars"] != natural+"-1" {
		t.Fatalf("IDs = %#v", ids)
	}
}

func TestCollisionUpgradePreservesMetadataAndRoutes(t *testing.T) {
	setupLibrary(t)
	names := []string{"Star Wars", "Star_Wars"}
	dates := map[string]string{}
	titles := map[string]string{}
	covers := map[string][]byte{}
	for i, name := range names {
		writeGame(t, name)
		dir := filepath.Join(rootDir, name)
		if err := os.WriteFile(filepath.Join(dir, "game.txt"), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
		dates[dir] = fmt.Sprintf("2026-10-%02dT12:00:00Z", i+1)
		titles[dir] = "Custom " + name
		covers[name] = []byte("folder " + name)
		if err := os.WriteFile(filepath.Join(dir, "cover.png"), covers[name], 0644); err != nil {
			t.Fatal(err)
		}
	}
	// Both current and legacy uploaded-art locations predate ID assignment.
	for i, name := range names {
		cover := customCoverPath(name)
		if i == 1 {
			cover = legacyCustomCoverPath(name)
		}
		if err := os.MkdirAll(filepath.Dir(cover), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cover, covers[name], 0600); err != nil {
			t.Fatal(err)
		}
	}
	// A version-1 state from before ID assignments existed.
	if err := writeLibraryMetadata(libraryState{Version: 1, FirstSeen: dates, Titles: titles}); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	ids := indexedIDs(t)
	for _, entry := range gamesMap {
		if entry.Game.Name != titles[entry.Game.Path] || entry.Game.AddedAt != dates[entry.Game.Path] || entry.Game.CoverSource != "uploaded" {
			t.Fatalf("upgrade lost existing metadata: %#v", entry.Game)
		}
	}
	if len(ids) != 2 || ids["Star_Wars"] != "star-wars" {
		t.Fatalf("legacy slug owner changed: %#v", ids)
	}
	for i, name := range names {
		id := ids[name]
		// Upload different valid art for each game through its public ID.
		img := image.NewRGBA(image.Rect(0, 0, 1, 1))
		img.Set(0, 0, color.RGBA{R: uint8(50 + i*100), A: 255})
		var body bytes.Buffer
		if err := png.Encode(&body, img); err != nil {
			t.Fatal(err)
		}
		covers[name] = append([]byte(nil), body.Bytes()...)
		req := httptest.NewRequest(http.MethodPut, "/api/covers/"+url.PathEscape(id), &body)
		req.Header.Set("Content-Type", "image/png")
		w := httptest.NewRecorder()
		handleCoverUpload(w, req)
		if w.Code != http.StatusNoContent {
			t.Fatalf("cover upload: %d %s", w.Code, w.Body.String())
		}
		titleBody, _ := json.Marshal(map[string]string{"title": "Edited " + name})
		w = httptest.NewRecorder()
		handleGameTitle(w, httptest.NewRequest(http.MethodPut, "/api/game-title/"+url.PathEscape(id), bytes.NewReader(titleBody)))
		if w.Code != http.StatusOK {
			t.Fatalf("title update: %d %s", w.Code, w.Body.String())
		}
	}
	gamesMap = make(map[string]*gameEntry)
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, indexedIDs(t)) {
		t.Fatal("metadata writes lost ID assignments")
	}
	games := decodeGames(t, requestGames(t, "/api/games", http.StatusOK))
	if len(games) != 2 {
		t.Fatal(games)
	}
	for _, game := range games {
		name := filepath.Base(game.Path)
		if game.Name != "Edited "+name || game.AddedAt != dates[game.Path] || game.CoverSource != "uploaded" || game.FileCount != 2 || game.SizeBytes != int64(len(name)+len("folder "+name)) {
			t.Fatalf("wrong game information: %#v", game)
		}
		w := httptest.NewRecorder()
		handleCover(w, httptest.NewRequest(http.MethodGet, "/covers/"+url.PathEscape(game.ID), nil))
		if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), covers[name]) {
			t.Fatalf("wrong cover for %q", name)
		}
		w = httptest.NewRecorder()
		handleGameFiles(w, httptest.NewRequest(http.MethodGet, "/api/game-files/"+url.PathEscape(game.ID), nil))
		var info struct {
			Files []gameFile `json:"files"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil || w.Code != http.StatusOK || len(info.Files) != 2 || info.Files[1].Path != "game.txt" || info.Files[1].SizeBytes != int64(len(name)) {
			t.Fatalf("wrong file information: %s (%v)", w.Body.String(), err)
		}
		w = httptest.NewRecorder()
		handleGameFileDownload(w, httptest.NewRequest(http.MethodGet, "/api/game-file/"+url.PathEscape(game.ID)+"?path=game.txt", nil))
		if w.Code != http.StatusOK || w.Body.String() != name {
			t.Fatalf("wrong file download for %q: %s", name, w.Body.String())
		}
		w = httptest.NewRecorder()
		handleDownload(w, httptest.NewRequest(http.MethodGet, "/download/"+url.PathEscape(game.ID), nil))
		if w.Code != http.StatusOK {
			t.Fatal(w.Code)
		}
		archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, member := range archive.File {
			if member.Name != "game.txt" {
				continue
			}
			f, err := member.Open()
			if err != nil {
				t.Fatal(err)
			}
			contents, err := io.ReadAll(f)
			f.Close()
			if err != nil || string(contents) != name {
				t.Fatalf("wrong ZIP for %q: %q (%v)", name, contents, err)
			}
			found = true
		}
		if !found {
			t.Fatalf("ZIP omitted game.txt for %q", name)
		}
	}
	state, err := readLibraryMetadata()
	if err != nil || !reflect.DeepEqual(state.FirstSeen, dates) || !reflect.DeepEqual(state.IDs, ids) {
		t.Fatalf("metadata = %#v (%v)", state, err)
	}
}

func TestGameIDAssignmentsValidateUniqueOwners(t *testing.T) {
	setupLibrary(t)
	for _, ids := range []map[string]string{
		{"Alpha": "shared", "Beta": "shared"},
		{"Alpha": ""}, {"Alpha": " "}, {"Alpha": "a/b"}, {"Alpha": `a\b`},
	} {
		if err := writeLibraryMetadata(libraryState{Version: 1, FirstSeen: map[string]string{}, IDs: ids}); err != nil {
			t.Fatal(err)
		}
		if _, err := readLibraryMetadata(); err == nil {
			t.Fatalf("accepted invalid IDs: %#v", ids)
		}
	}
}

// Clearing both structures models a real process restart.
func restartIndex() {
	gamesMap = make(map[string]*gameEntry)
	cachedIDs = nil
}

func TestTemporaryIDsStartupRescanRestartAndRecovery(t *testing.T) {
	for _, storage := range []string{"not-directory", "read-only"} {
		t.Run(storage, func(t *testing.T) {
			setupLibrary(t)
			originalData := dataDir
			if storage == "not-directory" {
				dataDir = filepath.Join(dataDir, "blocked")
				if err := os.WriteFile(dataDir, nil, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Chmod(dataDir, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(originalData, 0700) })
				if f, err := os.CreateTemp(dataDir, "probe"); err == nil {
					f.Close()
					os.Remove(f.Name())
					t.Skip("current user bypasses permissions")
				}
			}
			writeGame(t, "Star Wars")
			writeGame(t, "Star_Wars")
			assertScan := func(want map[string]string, persisted bool) map[string]string {
				t.Helper()
				requestGames(t, "/api/games?forceRefresh=1", http.StatusOK)
				got := indexedIDs(t)
				if len(got) != 2 || (want != nil && !reflect.DeepEqual(got, want)) {
					t.Fatalf("IDs = %#v; want %#v", got, want)
				}
				for _, entry := range gamesMap {
					if entry.Game.IDPersisted != persisted {
						t.Fatalf("incorrect persistence: %#v", entry.Game)
					}
					if !persisted && entry.Game.AddedAt != "" {
						t.Fatal("invented saved date")
					}
				}
				return got
			}
			before := assertScan(nil, false)
			assertScan(before, false)
			restartIndex()
			assertScan(before, false)
			// Reservations survive removal and re-addition during a process lifetime.
			if err := os.RemoveAll(filepath.Join(rootDir, "Star_Wars")); err != nil {
				t.Fatal(err)
			}
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			writeGame(t, "Star_Wars")
			assertScan(before, false)
			if storage == "not-directory" {
				if err := os.Remove(dataDir); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(dataDir, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Chmod(dataDir, 0700); err != nil {
				t.Fatal(err)
			}
			assertScan(before, true)
			state, err := readLibraryMetadata()
			if err != nil || !reflect.DeepEqual(state.IDs, before) {
				t.Fatalf("saved IDs: %#v (%v)", state.IDs, err)
			}
			restartIndex()
			assertScan(before, true)
		})
	}
}

func TestSavedIDsRemainAuthoritativeDuringWriteFailure(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Star Wars")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	before := indexedIDs(t)
	// A directory at the destination makes atomic replacement fail even as root,
	// while the state is unavailable. Keep the exact saved bytes for recovery.
	statePath := filepath.Join(dataDir, "library-state.json")
	contents, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(statePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0700); err != nil {
		t.Fatal(err)
	}
	writeGame(t, "Star_Wars")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	temporary := indexedIDs(t)
	if temporary["Star Wars"] != before["Star Wars"] || len(temporary) != 2 {
		t.Fatal(temporary)
	}
	if err := os.Remove(statePath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, contents, 0600); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(indexedIDs(t), temporary) {
		t.Fatal("recovery changed IDs")
	}
	restartIndex()
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(indexedIDs(t), temporary) {
		t.Fatal("restart changed recovered IDs")
	}
}

func TestUnavailableStatePreservesCachedCollisionIDs(t *testing.T) {
	setupLibrary(t)
	for _, name := range []string{"Star Wars", "Star_Wars"} {
		writeGame(t, name)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	before := indexedIDs(t)
	dates := make(map[string]string)
	for id, entry := range gamesMap {
		dates[id] = entry.Game.AddedAt
	}
	if err := os.WriteFile(filepath.Join(dataDir, "library-state.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(indexedIDs(t), before) {
		t.Fatal("unavailable state changed cached IDs")
	}
	for id, entry := range gamesMap {
		if entry.Game.AddedAt != dates[id] {
			t.Fatal("unavailable state lost cached first-seen date")
		}
	}
}

func TestReadableSavedIDsWithUnwritableStorage(t *testing.T) {
 setupLibrary(t)
 writeGame(t, "Star Wars")
 if err := refreshGames(); err != nil { t.Fatal(err) }
 statePath := filepath.Join(dataDir, "library-state.json")
 saved, err := os.ReadFile(statePath); if err != nil { t.Fatal(err) }
 if err := os.Chmod(dataDir, 0500); err != nil { t.Fatal(err) }
 t.Cleanup(func() { _ = os.Chmod(dataDir, 0700) })
 if f, err := os.CreateTemp(dataDir, "probe"); err == nil {
  f.Close(); os.Remove(f.Name()); t.Skip("current user bypasses permissions")
 }
 writeGame(t, "Star_Wars")
 restartIndex()
 if err := refreshGames(); err != nil { t.Fatal(err) }
 before := indexedIDs(t)
 if before["Star Wars"] != "star-wars" || !getGameEntryByID("star-wars").Game.IDPersisted || getGameEntryByID(before["Star_Wars"]).Game.IDPersisted {
  t.Fatalf("lost saved/temporary distinction: %#v", gamesMap)
 }
 contents, err := os.ReadFile(statePath)
 if err != nil || !bytes.Equal(contents, saved) { t.Fatal("write failure altered saved state") }
 if err := refreshGames(); err != nil { t.Fatal(err) }
 if !reflect.DeepEqual(indexedIDs(t), before) { t.Fatal("rescan changed IDs") }
 if err := os.Chmod(dataDir, 0700); err != nil { t.Fatal(err) }
 if err := refreshGames(); err != nil { t.Fatal(err) }
 if !reflect.DeepEqual(indexedIDs(t), before) { t.Fatal("recovery changed IDs") }
 for _, entry := range gamesMap { if !entry.Game.IDPersisted { t.Fatal("recovery left temporary ID") } }
}

func TestRecoveredSavedIDsOverrideConflictingTemporaryIDs(t *testing.T) {
 setupLibrary(t)
 writeGame(t, "Star Wars")
 // An invalid file is left untouched while browsing with temporary IDs.
 statePath := filepath.Join(dataDir, "library-state.json")
 if err := os.WriteFile(statePath, []byte("broken"), 0600); err != nil { t.Fatal(err) }
 if err := refreshGames(); err != nil { t.Fatal(err) }
 if getGameEntryByID("star-wars").Game.IDPersisted { t.Fatal("invalid state reported persisted") }
 // Restore a historical assignment that reserves the temporary URL for an absent folder.
 restored := map[string]string{"Absent": "star-wars", "Star Wars": "historical-id"}
 if err := writeLibraryMetadata(libraryState{Version: 1, FirstSeen: map[string]string{}, IDs: restored}); err != nil { t.Fatal(err) }
 if err := refreshGames(); err != nil { t.Fatal(err) }
 if getGameEntryByID("star-wars") != nil || getGameEntryByID("historical-id") == nil || !getGameEntryByID("historical-id").Game.IDPersisted {
  t.Fatal("temporary assignment overrode saved state")
 }
}
