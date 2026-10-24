package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
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
	value.LogOptions = defaultLogOptions()
	if err := json.Unmarshal(contents, &saved); err != nil || !reflect.DeepEqual(saved, value) { t.Fatalf("saved settings = %#v: %v", saved, err) }
	response := httptest.NewRecorder()
	handleServerSettings(response, httptest.NewRequest(http.MethodGet, "/api/server-settings", nil))
	if response.Code != http.StatusOK { t.Fatalf("GET status %d", response.Code) }
	outside := serverSettings{RootDir: filepath.Dir(root), DataDir: childData, RefreshInterval: "1h"}
	response = httptest.NewRecorder()
	body, _ := json.Marshal(outside)
	handleServerSettings(response, httptest.NewRequest(http.MethodPut, "/api/server-settings", strings.NewReader(string(body))))
	if response.Code != http.StatusBadRequest { t.Fatalf("outside path status %d", response.Code) }
}

func TestServerSettingsAcceptSeparateMountedSources(t *testing.T) {
	root := t.TempDir()
	data := t.TempDir()
	first, second := filepath.Join(root, "first"), filepath.Join(root, "second")
	for _, dir := range []string{first, second} { if err := os.Mkdir(dir, 0700); err != nil { t.Fatal(err) } }
	previousHome, previousRoot := settingsHome, allowedLibraryRoot
	t.Cleanup(func() { settingsHome, allowedLibraryRoot = previousHome, previousRoot })
	settingsHome, allowedLibraryRoot = data, root
	settings := serverSettings{RootDir:first, RootDirs:[]string{first, second}, DataDir:data, RefreshInterval:"0"}
	if err := validateServerSettings(settings); err != nil { t.Fatalf("separate sources rejected: %v", err) }
	settings.RootDirs = []string{root, first}
	settings.RootDir = root
	if err := validateServerSettings(settings); err != nil { t.Fatalf("share under primary mount rejected: %v", err) }
	settings.RootDirs = []string{root, root}
	if err := validateServerSettings(settings); err == nil { t.Fatal("duplicate source accepted") }
	nested := filepath.Join(first, "nested")
	if err := os.Mkdir(nested, 0700); err != nil { t.Fatal(err) }
	settings.RootDirs = []string{root, first, nested}
	if err := validateServerSettings(settings); err == nil { t.Fatal("overlapping secondary sources accepted") }
}
