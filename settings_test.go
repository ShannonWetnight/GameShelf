package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServerSettingsStayInsideConfiguredMounts(t *testing.T) {
	root := t.TempDir()
	data := t.TempDir()
	childRoot := filepath.Join(root, "library")
	childData := filepath.Join(data, "state")
	for _, dir := range []string{childRoot, childData} { if err := os.Mkdir(dir, 0700); err != nil { t.Fatal(err) } }
	previousHome, previousRoot, previousSettings := settingsHome, allowedLibraryRoot, configuredSettings
	t.Cleanup(func() { settingsHome, allowedLibraryRoot, configuredSettings = previousHome, previousRoot, previousSettings })
	settingsHome, allowedLibraryRoot = data, root
	value := serverSettings{RootDir: childRoot, DataDir: childData, RefreshInterval: "30m", Verbose: true}
	if err := saveServerSettings(value); err != nil { t.Fatal(err) }
	contents, err := os.ReadFile(filepath.Join(data, "server-settings.json"))
	if err != nil { t.Fatal(err) }
	var saved serverSettings
	if err := json.Unmarshal(contents, &saved); err != nil || saved != value { t.Fatalf("saved settings = %#v: %v", saved, err) }
	response := httptest.NewRecorder()
	handleServerSettings(response, httptest.NewRequest(http.MethodGet, "/api/server-settings", nil))
	if response.Code != http.StatusOK { t.Fatalf("GET status %d", response.Code) }
	outside := serverSettings{RootDir: filepath.Dir(root), DataDir: childData, RefreshInterval: "1h"}
	response = httptest.NewRecorder()
	body, _ := json.Marshal(outside)
	handleServerSettings(response, httptest.NewRequest(http.MethodPut, "/api/server-settings", strings.NewReader(string(body))))
	if response.Code != http.StatusBadRequest { t.Fatalf("outside path status %d", response.Code) }
}
