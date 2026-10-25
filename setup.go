package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	setupRequired       atomic.Bool
	setupMu             sync.Mutex
	libraryRuntimeMu    sync.RWMutex
	mountedLibraryRoots []string // immutable after startup
	refreshSchedule     = make(chan struct{}, 1)
)

// Only explicitly configured or separately mounted directories are library sources.
// Never expose the container's root filesystem through the folder picker.
func parseLibraryMounts(contents, home string) []string {
	var roots []string
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	for _, line := range strings.Split(contents, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		directory := filepath.Clean(unescape.Replace(fields[4]))
		if !filepath.IsAbs(directory) || directory == string(os.PathSeparator) {
			continue
		}
		blocked := false
		for _, base := range []string{"/proc", "/sys", "/dev", "/etc", "/app", "/run", "/data", home} {
			if base != "" && (directory == base || strings.HasPrefix(directory, base+string(os.PathSeparator))) {
				blocked = true
				break
			}
		}
		if !blocked {
			roots = append(roots, directory)
		}
	}
	sort.Strings(roots)
	return roots
}

func discoverLibraryMounts() []string {
	contents, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	var roots []string
	for _, directory := range parseLibraryMounts(string(contents), settingsHome) {
		if info, err := os.Stat(directory); err == nil && info.IsDir() {
			roots = append(roots, directory)
		}
	}
	return roots
}

func libraryMounts() []string {
	roots := append([]string(nil), mountedLibraryRoots...)
	if allowedLibraryRoot != "" {
		roots = append(roots, allowedLibraryRoot)
	}
	sort.Strings(roots)
	result := make([]string, 0, len(roots))
	for _, root := range roots {
		if len(result) == 0 || result[len(result)-1] != root {
			result = append(result, root)
		}
	}
	return result
}

func readableLibraryMounts() []string {
	roots := make([]string, 0)
	for _, directory := range libraryMounts() {
		if _, err := os.ReadDir(directory); err == nil {
			roots = append(roots, directory)
		}
	}
	return roots
}

func libraryPathAllowed(directory string) bool {
	for _, root := range libraryMounts() {
		if pathInside(root, directory) {
			return true
		}
	}
	return false
}

func notifyRefreshSchedule() {
	select {
	case refreshSchedule <- struct{}{}:
	default:
	}
}

// Wait quietly while setup is incomplete. Changing the schedule wakes the timer.
func runAutoRefresh() {
	for {
		settingsMu.RLock()
		interval := configuredRefreshInterval(configuredSettings.RefreshInterval)
		settingsMu.RUnlock()
		if setupRequired.Load() || interval <= 0 {
			<-refreshSchedule
			continue
		}
		timer := time.NewTimer(interval)
		select {
		case <-timer.C:
			if !setupRequired.Load() {
				if err := refreshGames(); err != nil {
					logEvent("errors", "periodic scan error: %v", err)
				}
			}
		case <-refreshSchedule:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
	}
}

func setupGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A page on another website must not change this LAN app's settings or
		// ask it to connect to a server. Non-browser API clients remain usable.
		unsafe := r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions
		if unsafe || r.URL.Query().Has("forceRefresh") {
			origin := r.Header.Get("Origin")
			parsed, err := url.Parse(origin)
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" || (origin != "" && (err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || !strings.EqualFold(parsed.Host, r.Host) || parsed.User != nil)) {
				http.Error(w, "Open GameShelf directly to make this change.", http.StatusForbidden)
				return
			}
		}
		configuration := r.URL.Path == "/api/setup" || r.URL.Path == "/api/network-test" || r.URL.Path == "/api/source-status" || r.URL.Path == "/api/library-folders" || r.URL.Path == "/api/server-settings" || r.URL.Path == "/api/server-settings/reset" || r.URL.Path == "/api/version" || r.URL.Path == "/api/logs"
		libraryRoute := !configuration && (strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/download") || strings.HasPrefix(r.URL.Path, "/covers/"))
		if libraryRoute {
			// Finish any active library responses before setup replaces runtime paths.
			libraryRuntimeMu.RLock()
			defer libraryRuntimeMu.RUnlock()
			if setupRequired.Load() {
				if r.URL.Path == "/api/games" && r.Method == http.MethodGet {
					w.Header().Set("Content-Type", "application/json")
					w.Write([]byte("[]\n"))
					return
				}
				http.Error(w, "Complete GameShelf setup to use your library.", http.StatusConflict)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func handleSetup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		settingsMu.RLock()
		value := configuredSettings
		settingsMu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Required bool           `json:"required"`
			Mounts   []string       `json:"mounts"`
			Port     int            `json:"port"`
			Settings serverSettings `json:"settings"`
		}{setupRequired.Load(), readableLibraryMounts(), 8080, publicSettings(value)})
	case http.MethodPost:
		setupMu.Lock()
		defer setupMu.Unlock()
		if !setupRequired.Load() {
			http.Error(w, "Setup is already complete. Use Settings to change your library.", http.StatusConflict)
			return
		}
		var value serverSettings
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 524288))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&value); err != nil {
			http.Error(w, "Check your setup options and try again.", http.StatusBadRequest)
			return
		}
		if !hasLibrary(value) {
			http.Error(w, "Choose at least one folder or network location.", http.StatusBadRequest)
			return
		}
		if err := validateServerSettings(value); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := saveServerSettings(value); err != nil {
			logEvent("errors", "first-time setup save: %v", err)
			http.Error(w, "Could not save setup. Check that the data folder is writable by GameShelf.", http.StatusServiceUnavailable)
			return
		}
		// Library endpoints are gated until these initial runtime paths and the
		// first complete index are ready. Later library edits apply live.
		libraryRuntimeMu.Lock()
		defer libraryRuntimeMu.Unlock()
		settingsMu.RLock()
		saved := configuredSettings
		settingsMu.RUnlock()
		refreshMu.Lock()
		rootDir, rootDirs, dataDir = saved.RootDir, libraryRoots(saved), saved.DataDir
		setActiveSources(saved.Sources)
		refreshMu.Unlock()
		if err := refreshGames(); err != nil {
			http.Error(w, "Could not read your library. Check the location, connection, and permissions, then try again.", http.StatusBadRequest)
			return
		}
		setupRequired.Store(false)
		notifyRefreshSchedule()
		logEvent("system", "First-time setup complete")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"complete": true, "settings": publicSettings(saved)})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleLibraryFolders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	directory := r.URL.Query().Get("path")
	parent := ""
	folders := readableLibraryMounts()
	if directory != "" {
		directory = filepath.Clean(directory)
		if !filepath.IsAbs(directory) || !libraryPathAllowed(directory) {
			http.Error(w, "Choose a folder inside a mounted library directory.", http.StatusBadRequest)
			return
		}
		if pathInside(settingsHome, directory) {
			http.Error(w, "This folder is reserved for saved GameShelf data.", http.StatusBadRequest)
			return
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			http.Error(w, "GameShelf cannot read this folder. Check its mapping and permissions.", http.StatusBadRequest)
			return
		}
		folders = make([]string, 0)
		for _, entry := range entries {
			child := filepath.Join(directory, entry.Name())
			if entry.IsDir() && !pathInside(settingsHome, child) {
				folders = append(folders, child)
			}
			if len(folders) >= 1000 {
				break
			}
		}
		candidate := filepath.Dir(directory)
		if candidate != directory && libraryPathAllowed(candidate) {
			parent = candidate
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(struct {
		Path    string   `json:"path"`
		Parent  string   `json:"parent"`
		Folders []string `json:"folders"`
	}{directory, parent, folders})
}
