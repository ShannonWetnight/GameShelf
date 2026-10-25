package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func setupFreshServer(t *testing.T) (string, string) {
	t.Helper()
	root := setupLibrary(t)
	data := dataDir
	oldHome, oldAllowed, oldMounts, oldSettings, oldRequired, oldOutput := settingsHome, allowedLibraryRoot, mountedLibraryRoots, configuredSettings, setupRequired.Load(), log.Writer()
	t.Cleanup(func() {
		settingsHome, allowedLibraryRoot, mountedLibraryRoots, configuredSettings = oldHome, oldAllowed, oldMounts, oldSettings
		setupRequired.Store(oldRequired)
		verboseLogging.Store(oldSettings.Verbose)
		log.SetOutput(oldOutput)
		select {
		case <-refreshSchedule:
		default:
		}
	})
	t.Setenv("GAMESHELF_ROOT", "")
	t.Setenv("GAMESHELF_DATA_DIR", data)
	t.Setenv("GAMESHELF_REFRESH_INTERVAL", "")
	value := initializeServerSettings()
	rootDir, rootDirs, dataDir = value.RootDir, libraryRoots(value), value.DataDir
	mountedLibraryRoots = []string{root}
	return root, data
}

func TestFirstSetupHasNoAssumedLibraryAndGuardsScans(t *testing.T) {
	_, data := setupFreshServer(t)
	if configuredSettings.RootDir != "" || len(libraryRoots(configuredSettings)) != 0 || !setupRequired.Load() {
		t.Fatalf("fresh settings: %#v", configuredSettings)
	}
	if configuredSettings.DataDir != data || configuredSettings.RefreshInterval != "168h" {
		t.Fatal(configuredSettings)
	}
	called := false
	handler := setupGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	for i := 0; i < 3; i++ {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/games?forceRefresh=1", nil))
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" || called {
			t.Fatalf("setup tried a scan: %d %s", w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/library-backup", nil))
	if w.Code != http.StatusConflict || called {
		t.Fatal("library access was not gated")
	}
}

func TestFirstSetupValidatesSavesAndIndexesWithoutRestart(t *testing.T) {
	root, data := setupFreshServer(t)
	if err := os.Mkdir(filepath.Join(root, "First Game"), 0755); err != nil {
		t.Fatal(err)
	}
	value := serverSettings{RootDir: root, RootDirs: []string{root}, DataDir: data, RefreshInterval: "168h"}
	send := func(value serverSettings) *httptest.ResponseRecorder {
		body, _ := json.Marshal(value)
		w := httptest.NewRecorder()
		handleSetup(w, httptest.NewRequest(http.MethodPost, "/api/setup", strings.NewReader(string(body))))
		return w
	}
	bad := value
	bad.RootDir = filepath.Dir(root)
	bad.RootDirs = []string{bad.RootDir}
	if w := send(bad); w.Code != http.StatusBadRequest {
		t.Fatalf("outside mount accepted: %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(settingsFile()); !os.IsNotExist(err) {
		t.Fatal("invalid setup was persisted")
	}
	if w := send(value); w.Code != http.StatusOK {
		t.Fatalf("setup: %d %s", w.Code, w.Body.String())
	}
	if setupRequired.Load() || rootDir != root || len(gamesMap) != 1 || lastIndexedAt.IsZero() {
		t.Fatal("setup did not activate/index library")
	}
	contents, err := os.ReadFile(settingsFile())
	if err != nil {
		t.Fatal(err)
	}
	var saved serverSettings
	if err = json.Unmarshal(contents, &saved); err != nil || saved.RootDir != root {
		t.Fatal("setup did not persist")
	}
	if w := send(value); w.Code != http.StatusConflict {
		t.Fatal("setup overwrote a configured library")
	}
	value.RefreshInterval = "24h"
	body, _ := json.Marshal(value)
	w := httptest.NewRecorder()
	handleServerSettings(w, httptest.NewRequest(http.MethodPut, "/api/server-settings", strings.NewReader(string(body))))
	var result struct {
		RestartRequired bool `json:"restartRequired"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 || result.RestartRequired {
		t.Fatalf("interval should apply without restart: %s", w.Body.String())
	}
}

func TestLibraryFolderPickerStaysInsideMountedDirectories(t *testing.T) {
	root, _ := setupFreshServer(t)
	child := filepath.Join(root, "Collection")
	if err := os.Mkdir(child, 0755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "Outside")); err != nil {
		t.Fatal(err)
	}
	request := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/api/library-folders", nil)
		q := r.URL.Query()
		q.Set("path", path)
		r.URL.RawQuery = q.Encode()
		handleLibraryFolders(w, r)
		return w
	}
	for _, path := range []string{filepath.Dir(root), filepath.Join(root, "Outside"), settingsHome} {
		if w := request(path); w.Code != 400 {
			t.Fatalf("outside picker path accepted: %s", path)
		}
	}
	w := request(root)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var list struct {
		Path, Parent string
		Folders      []string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Parent != "" || !reflect.DeepEqual(list.Folders, []string{child}) {
		t.Fatalf("folder listing: %#v", list)
	}
	w = request(child)
	if !strings.Contains(w.Body.String(), root) {
		t.Fatal("picker lost parent navigation")
	}
}

func TestMountDiscoveryExcludesContainerSystemAndDataPaths(t *testing.T) {
	contents := "1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /proc rw - proc proc rw\n3 1 0:3 / /etc/hosts rw - ext4 disk rw\n4 1 0:4 / /data rw - ext4 disk rw\n5 1 0:5 / /libraries/Shared\\040Games ro - ext4 disk rw\n6 1 0:6 / /collection ro - ext4 disk rw\n7 1 0:7 / /saved-data rw - ext4 disk rw"
	got := parseLibraryMounts(contents, "/saved-data")
	want := []string{"/collection", "/libraries/Shared Games"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mounts = %#v", got)
	}
}

func TestExplicitComposeRootSkipsFirstSetup(t *testing.T) {
	root, data := setupFreshServer(t)
	t.Setenv("GAMESHELF_ROOT", root)
	t.Setenv("GAMESHELF_DATA_DIR", data)
	value := initializeServerSettings()
	if setupRequired.Load() || value.RootDir != root {
		t.Fatal("explicit library was ignored")
	}
}

func TestResetWithoutComposeRootReturnsToSetup(t *testing.T) {
	root, data := setupFreshServer(t)
	value := serverSettings{RootDir: root, DataDir: data, RefreshInterval: "0"}
	body, _ := json.Marshal(value)
	w := httptest.NewRecorder()
	handleSetup(w, httptest.NewRequest(http.MethodPost, "/api/setup", strings.NewReader(string(body))))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = httptest.NewRecorder()
	handleResetServerSettings(w, httptest.NewRequest(http.MethodPost, "/api/server-settings/reset", nil))
	if w.Code != 200 || !setupRequired.Load() || configuredSettings.RootDir != "" {
		t.Fatalf("reset did not reopen setup: %d %#v", w.Code, configuredSettings)
	}
}

func TestConfigurationRejectsCrossSiteBrowserRequests(t *testing.T) {
	for _, sample := range []struct {
		method, path, origin, site string
		allowed                    bool
	}{
		{"POST", "/api/network-test", "https://games.lab", "same-origin", true},
		{"PUT", "/api/server-settings", "https://other.lab", "same-site", false},
		{"POST", "/api/setup", "https://unrelated.example", "cross-site", false},
		{"POST", "/api/setup", "", "cross-site", false},
		{"POST", "/api/network-test", "null", "", false},
		{"PUT", "/api/server-settings", "", "", true},
		{"GET", "/api/version", "https://unrelated.example", "cross-site", true},
		{"GET", "/api/games?forceRefresh=1", "https://unrelated.example", "cross-site", false},
	} {
		called := false
		handler := setupGate(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
		request := httptest.NewRequest(sample.method, "https://games.lab"+sample.path, nil)
		request.Header.Set("Origin", sample.origin)
		request.Header.Set("Sec-Fetch-Site", sample.site)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if called != sample.allowed {
			t.Fatalf("%s %s origin %q: allowed=%v", sample.method, sample.path, sample.origin, called)
		}
		if !sample.allowed && response.Code != http.StatusForbidden {
			t.Fatal(response.Code)
		}
	}
}

func TestDeferredSetupPersistsAndCanBeConfiguredLater(t *testing.T) {
	root, _ := setupFreshServer(t)
	response := httptest.NewRecorder()
	handleSetup(response, httptest.NewRequest("POST", "/api/setup?skip=1", nil))
	if response.Code != 200 || setupRequired.Load() || !configuredSettings.SetupCompleted || hasLibrary(configuredSettings) {
		t.Fatalf("skip: %d %s", response.Code, response.Body.String())
	}
	value := initializeServerSettings()
	if setupRequired.Load() || !value.SetupCompleted {
		t.Fatal("deferred setup was not remembered")
	}
	mountedLibraryRoots = []string{root}
	value.RootDir = root
	value.RootDirs = []string{root}
	contents, _ := json.Marshal(value)
	response = httptest.NewRecorder()
	handleServerSettings(response, httptest.NewRequest("PUT", "/api/server-settings", bytes.NewReader(contents)))
	if response.Code != 200 || rootDir != root {
		t.Fatalf("manual sources: %s", response.Body.String())
	}
}
func TestFirstSetupImportsBackupWithoutCredentialsOrRestart(t *testing.T) {
	_, data := setupFreshServer(t)
	oldList, oldSources := networkList, snapshotSources()
	t.Cleanup(func() { networkList = oldList; setActiveSources(oldSources) })
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) {
		return []remoteItem{{Path: "Restored Game", IsDir: true}}, nil
	}
	value := serverSettings{RootDir: "", DataDir: "/previous-server-data", RefreshInterval: "24h", Sources: []networkSource{{ID: newSourceID(), Protocol: "smb", URL: "smb://nas/games", Username: "reader", HasPassword: true, Password: "must-not-restore", PasswordCipher: "must-not-restore-cipher"}}, Preferences: map[string]string{"theme": "neon", "list-image-click": "double"}}
	settings, _ := json.Marshal(value)
	backup := restoreZIP(t, map[string][]byte{"server-settings.json": settings})
	handler := setupGate(http.HandlerFunc(handleLibraryRestore))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/library-restore", bytes.NewReader(backup)))
	if response.Code != 200 {
		t.Fatalf("gated preview: %d %s", response.Code, response.Body.String())
	}
	var preview struct {
		SHA           string `json:"sha256"`
		RequiresLogin bool   `json:"requiresLogin"`
	}
	json.Unmarshal(response.Body.Bytes(), &preview)
	if !preview.RequiresLogin {
		t.Fatal("missing password notice")
	}
	request := httptest.NewRequest("POST", "/api/library-restore?apply=1&settings=1", bytes.NewReader(backup))
	request.Header.Set("X-Preview-SHA256", preview.SHA)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	deadline := time.Now().Add(2 * time.Second)
	for {
		scanProgressMu.Lock()
		busy := scanBusy
		scanProgressMu.Unlock()
		if !busy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("restore scan did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	if response.Code != 200 || setupRequired.Load() || !configuredSettings.SetupCompleted || configuredSettings.DataDir != data {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	source := configuredSettings.Sources[0]
	if source.Username != "reader" || source.Password != "" || source.PasswordCipher != "" || source.HasPassword {
		t.Fatal("import retained a password or lost username")
	}
	if configuredSettings.Preferences["theme"] != "neon" || len(gamesMap) != 1 {
		t.Fatal("settings or library were not activated")
	}
}
func TestBackupPreferenceWhitelist(t *testing.T) {
	for _, values := range []map[string]string{{"password": "secret"}, {"theme": "system|classic"}, {"animation-speed": "NaN"}, {"list-opacity": "101"}, {"view": "javascript"}} {
		if validatePreferences(values) == nil {
			t.Fatalf("unsafe preferences accepted: %#v", values)
		}
	}
	if err := validatePreferences(map[string]string{"theme": "classic", "animation-speed": "1.1", "list-opacity": "80", "show-game-titles": "false"}); err != nil {
		t.Fatal(err)
	}
}

func TestBackupIncludesSafePreferencesAndRedactsCredentials(t *testing.T) {
	root, data := setupFreshServer(t)
	settingsMu.Lock()
	configuredSettings = serverSettings{RootDir: root, DataDir: data, RefreshInterval: "168h", SetupCompleted: true, Sources: []networkSource{{ID: newSourceID(), Protocol: "smb", URL: "smb://nas/games", Username: "reader", Password: "plaintext-secret", PasswordCipher: "encrypted-secret"}}}
	settingsMu.Unlock()
	request := httptest.NewRequest("GET", "/api/library-backup?select=1&settings=1", nil)
	request.Header.Set("X-GameShelf-Preferences", `{"theme":"neon","list-opacity":"80","favorites-first":"true"}`)
	response := httptest.NewRecorder()
	handleLibraryBackup(response, request)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	archive, err := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 1 || archive.File[0].Name != "server-settings.json" {
		t.Fatal("unexpected backup files")
	}
	reader, err := archive.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	contents, err := io.ReadAll(reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"plaintext-secret", "encrypted-secret", "passwordCipher"} {
		if bytes.Contains(contents, []byte(secret)) {
			t.Fatalf("secret exported: %s", secret)
		}
	}
	var saved serverSettings
	if err = json.Unmarshal(contents, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Sources[0].Username != "reader" || saved.Sources[0].URL != "smb://nas/games" || saved.Preferences["theme"] != "neon" || !saved.SetupCompleted {
		t.Fatal("restore configuration missing")
	}
	request = httptest.NewRequest("GET", "/api/library-backup?select=1&settings=1", nil)
	request.Header.Set("X-GameShelf-Preferences", `{"password":"must-not-backup"}`)
	response = httptest.NewRecorder()
	handleLibraryBackup(response, request)
	if response.Code != 400 {
		t.Fatal("unapproved browser data accepted")
	}
}

func TestRejectedRestoreDoesNotMutateActiveConnection(t *testing.T) {
	_, data := setupFreshServer(t)
	original := networkSource{ID: newSourceID(), Protocol: "smb", URL: "smb://nas/games", Username: "reader", PasswordCipher: "saved-credential"}
	settingsMu.Lock()
	configuredSettings.Sources = []networkSource{original}
	settingsMu.Unlock()
	invalid := serverSettings{DataDir: data, RefreshInterval: "invalid", Sources: []networkSource{{ID: original.ID, Protocol: "smb", URL: "smb://another/games", Username: "other"}}}
	settings, _ := json.Marshal(invalid)
	backup := restoreZIP(t, map[string][]byte{"server-settings.json": settings})
	preview := httptest.NewRecorder()
	handleLibraryRestore(preview, httptest.NewRequest("POST", "/api/library-restore", bytes.NewReader(backup)))
	var result struct {
		SHA string `json:"sha256"`
	}
	json.Unmarshal(preview.Body.Bytes(), &result)
	request := httptest.NewRequest("POST", "/api/library-restore?apply=1&settings=1", bytes.NewReader(backup))
	request.Header.Set("X-Preview-SHA256", result.SHA)
	response := httptest.NewRecorder()
	handleLibraryRestore(response, request)
	if response.Code != 400 {
		t.Fatal(response.Code, response.Body.String())
	}
	if configuredSettings.Sources[0] != original {
		t.Fatal("failed import changed live credentials")
	}
}

func TestOnlyUnfinishedSetupCanBeReopened(t *testing.T) {
	root, _ := setupFreshServer(t)
	value := configuredSettings
	value.SetupCompleted = true
	value.SetupStatus = "complete"
	value.RootDir = root
	if err := saveServerSettings(value); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handleSetupRestart(response, httptest.NewRequest("POST", "/api/setup/restart", nil))
	if response.Code != 409 {
		t.Fatal("completed setup could be reopened")
	}
	value.SetupStatus = "skipped"
	if err := saveServerSettings(value); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	handleSetupRestart(response, httptest.NewRequest("POST", "/api/setup/restart", nil))
	if response.Code != 200 || !setupRequired.Load() {
		t.Fatal(response.Code, response.Body.String())
	}
	t.Setenv("GAMESHELF_ROOT", root)
	reloaded := initializeServerSettings()
	if !setupRequired.Load() || reloaded.SetupStatus != "pending" || reloaded.RootDir != root {
		t.Fatal("unfinished setup or library choices lost on restart")
	}
}
func TestDisplaySettingsEventsRejectSecretsAndRecordSafeChanges(t *testing.T) {
	setupFreshServer(t)
	response := httptest.NewRecorder()
	handleSettingsEvent(response, httptest.NewRequest("POST", "/api/settings-events", strings.NewReader(`{"theme":"random","stretch-covers":"true"}`)))
	if response.Code != 204 {
		t.Fatal(response.Code, response.Body.String())
	}
	snapshot := string(applicationLogs.Snapshot())
	if !strings.Contains(snapshot, "Display setting changed: theme=random") || !strings.Contains(snapshot, "stretch-covers=true") {
		t.Fatal("setting events not recorded")
	}
	for _, payload := range []string{`{"password":"private-secret"}`, `{"theme":"light\nforged-log"}`, `{"stretch-covers":"yes"}`} {
		response = httptest.NewRecorder()
		handleSettingsEvent(response, httptest.NewRequest("POST", "/api/settings-events", strings.NewReader(payload)))
		if response.Code != 400 {
			t.Fatal("unsafe event accepted")
		}
	}
	if strings.Contains(string(applicationLogs.Snapshot()), "private-secret") {
		t.Fatal("credential value logged")
	}
}
func TestCoverFitOverridesPersistAndExportIncludingExplicitFalse(t *testing.T) {
	root := setupLibrary(t)
	folder := filepath.Join(root, "Alpha")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"true", "false"} {
		request := httptest.NewRequest("PUT", "/api/cover-fit/alpha", strings.NewReader(`{"stretch":`+value+`}`))
		response := httptest.NewRecorder()
		handleCoverFit(response, request)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		if err := refreshGames(); err != nil {
			t.Fatal(err)
		}
		game := getGameEntryByID("alpha").Game
		if game.CoverStretch == nil || *game.CoverStretch != (value == "true") {
			t.Fatal("fit override not retained after refresh")
		}
	}
	var output bytes.Buffer
	if err := writeLibraryBackupSelectionExtra(&output, true, false, false, map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	archive, err := parseRestoreArchive(output.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	state, err := parseLibraryMetadata(archive.state)
	if err != nil {
		t.Fatal(err)
	}
	if value, ok := state.CoverStretch[folder]; !ok || value {
		t.Fatal("explicit false was lost from the backup")
	}
	response := httptest.NewRecorder()
	handleCoverFit(response, httptest.NewRequest("PUT", "/api/cover-fit/alpha", strings.NewReader(`{"stretch":null}`)))
	if response.Code != 200 || getGameEntryByID("alpha").Game.CoverStretch != nil {
		t.Fatal("could not return to global fit")
	}
	response = httptest.NewRecorder()
	handleCoverFit(response, httptest.NewRequest("PUT", "/api/cover-fit/alpha", strings.NewReader(`{"stretch":true,"path":"/etc/passwd"}`)))
	if response.Code != 400 {
		t.Fatal("unexpected cover-fit field accepted")
	}
}
func TestDefaultLogRetentionHasNoAgeLimitButRemainsSizeBounded(t *testing.T) {
	var retained boundedLog
	retained.Configure(defaultLogOptions())
	retained.Write([]byte(time.Now().Add(-180*24*time.Hour).Format("2006/01/02 15:04:05") + " old retained entry\n"))
	if !strings.Contains(string(retained.Snapshot()), "old retained entry") {
		t.Fatal("default age still prunes logs")
	}
	retained.Configure(&logOptions{OverrideDays: true, Days: 7})
	if strings.Contains(string(retained.Snapshot()), "old retained entry") {
		t.Fatal("optional age limit ignored")
	}
	retained.Configure(&logOptions{OverrideSize: true, SizeMB: 1})
	retained.Write(bytes.Repeat([]byte("size-bound-entry\n"), 100000))
	if len(retained.Snapshot()) > 1<<20 {
		t.Fatal("unlimited age disabled size bound")
	}
}
