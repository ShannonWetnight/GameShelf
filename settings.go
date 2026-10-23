package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type serverSettings struct {
	RootDir string `json:"rootDir"`
	DataDir string `json:"dataDir"`
	RefreshInterval string `json:"refreshInterval"`
	Verbose bool `json:"verbose"`
}

var (
	settingsMu sync.RWMutex
	configuredSettings serverSettings
	settingsHome string
	allowedLibraryRoot string
	verboseLogging atomic.Bool
	applicationLogs boundedLog
)

// Keep a bounded log snapshot so exports do not depend on Docker log access.
type boundedLog struct {
	mu sync.Mutex
	data []byte
}

func (b *boundedLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	const limit = 1 << 20
	if len(b.data) > limit {
		b.data = bytes.Clone(b.data[len(b.data)-limit:])
	}
	return len(p), nil
}

func (b *boundedLog) Snapshot() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.data)
}

func defaultServerSettings() serverSettings {
	root := os.Getenv("GAMESHELF_ROOT")
	if root == "" { root = "/games" }
	data := os.Getenv("GAMESHELF_DATA_DIR")
	if data == "" { data = "/data" }
	interval := os.Getenv("GAMESHELF_REFRESH_INTERVAL")
	if interval == "" { interval = "12h" }
	return serverSettings{RootDir: root, DataDir: data, RefreshInterval: interval}
}

func settingsFile() string { return filepath.Join(settingsHome, "server-settings.json") }

func pathInside(base, candidate string) bool {
	baseAbs, err := filepath.EvalSymlinks(base)
	if err != nil { return false }
	candidateAbs, err := filepath.EvalSymlinks(candidate)
	if err != nil { return false }
	rel, err := filepath.Rel(baseAbs, candidateAbs)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func validRefreshInterval(value string) bool {
	if value == "0" { return true }
	duration, err := time.ParseDuration(value)
	return err == nil && duration > 0
}

func validateServerSettings(value serverSettings) error {
	if !filepath.IsAbs(value.RootDir) || !filepath.IsAbs(value.DataDir) || !filepath.IsLocal(filepath.Base(value.RootDir)) || !filepath.IsLocal(filepath.Base(value.DataDir)) {
		return errors.New("paths must be absolute container paths")
	}
	if !pathInside(allowedLibraryRoot, value.RootDir) || !pathInside(settingsHome, value.DataDir) {
		return errors.New("paths must stay within the configured library and data mounts")
	}
	if !validRefreshInterval(value.RefreshInterval) { return errors.New("refresh interval must be a positive duration or 0") }
	for _, directory := range []string{value.RootDir, value.DataDir} {
		info, err := os.Stat(directory)
		if err != nil || !info.IsDir() { return fmt.Errorf("directory is unavailable: %s", directory) }
	}
	return nil
}

func initializeServerSettings() serverSettings {
	defaults := defaultServerSettings()
	settingsHome = defaults.DataDir
	allowedLibraryRoot = defaults.RootDir
	log.SetOutput(io.MultiWriter(os.Stdout, &applicationLogs))
	value := defaults
	contents, err := os.ReadFile(settingsFile())
	if err == nil {
		if jsonErr := json.Unmarshal(contents, &value); jsonErr != nil || validateServerSettings(value) != nil {
			log.Printf("invalid saved server settings; using container defaults")
			value = defaults
		}
	} else if !os.IsNotExist(err) {
		log.Printf("server settings unavailable: %v", err)
	}
	settingsMu.Lock()
	configuredSettings = value
	settingsMu.Unlock()
	verboseLogging.Store(value.Verbose)
	return value
}

func saveServerSettings(value serverSettings) error {
	if err := validateServerSettings(value); err != nil { return err }
	contents, err := json.MarshalIndent(value, "", "  ")
	if err != nil { return err }
	file, err := os.CreateTemp(settingsHome, ".server-settings-*.tmp")
	if err != nil { return err }
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil { _, err = file.Write(append(contents, '\n')) }
	if err == nil { err = file.Sync() }
	if closeErr := file.Close(); err == nil { err = closeErr }
	if err != nil { return err }
	if err := os.Rename(file.Name(), settingsFile()); err != nil { return err }
	settingsMu.Lock()
	configuredSettings = value
	settingsMu.Unlock()
	verboseLogging.Store(value.Verbose)
	return nil
}

func handleServerSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settingsMu.RLock()
		value := configuredSettings
		settingsMu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(value)
	case http.MethodPut:
		var value serverSettings
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&value); err != nil { http.Error(w, "invalid settings", http.StatusBadRequest); return }
		settingsMu.RLock()
		old := configuredSettings
		settingsMu.RUnlock()
		if err := saveServerSettings(value); err != nil { http.Error(w, err.Error(), http.StatusBadRequest); return }
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct { RestartRequired bool `json:"restartRequired"` }{old.RootDir != value.RootDir || old.DataDir != value.DataDir || old.RefreshInterval != value.RefreshInterval})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
