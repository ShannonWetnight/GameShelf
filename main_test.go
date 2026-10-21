package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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
	previousRoot, previousData, previousGames := rootDir, dataDir, gamesMap
	t.Cleanup(func() { rootDir, dataDir, gamesMap = previousRoot, previousData, previousGames })
	rootDir = t.TempDir()
	dataDir = t.TempDir()
	gamesMap = make(map[string]*gameEntry)
	return rootDir
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
	for _, failure := range []string{"missing", "read-error", "permission-denied"} {
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

