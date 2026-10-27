package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Destructive confirmations use a new, single-use PIN permit. Remembered
// grants and open-menu leases never satisfy this check.
func checkFreshPIN(w http.ResponseWriter, r *http.Request, actions []string) bool {
	_, configured, err := currentAccessPolicy()
	if err != nil {
		writeAccessError(w, 503, "access_unavailable", nil, "Guardian PIN is unavailable.")
		return false
	}
	if !configured {
		writeAccessError(w, 428, "pin_setup_required", actions, "Create a Guardian PIN before continuing.")
		return false
	}
	if usePINPermit(w, r, actions) {
		return true
	}
	writeAccessError(w, 423, "pin_required", actions, "Enter your Guardian PIN for this action.")
	return false
}

// Stage only known application-owned paths beneath the original data home.
// A rename failure is rolled back before anything is deleted. OpenRoot keeps
// symlinks from turning a Wipe into deletion of games or unrelated host files.
func wipeOwnedState(defaults serverSettings) error {
	home, err := os.OpenRoot(settingsHome)
	if err != nil {
		return err
	}
	defer home.Close()
	key, err := randomKey()
	if err != nil {
		return err
	}
	stage := ".gameshelf-wipe-" + key
	if err = home.Mkdir(stage, 0700); err != nil {
		return err
	}
	type movedPath struct{ from, to string }
	var moved []movedPath
	rollback := func() {
		for i := len(moved) - 1; i >= 0; i-- {
			home.Rename(moved[i].to, moved[i].from)
		}
		home.RemoveAll(stage)
	}
	names := []string{"server-settings.json", ".family-pin.json", ".family-profiles.json", ".network-key", "library-state.json", "network-index.json", "library-health.json", "covers", "network-covers"}
	settingsMu.RLock()
	pending := configuredSettings.DataDir
	settingsMu.RUnlock()
	seen := map[string]bool{}
	for _, directory := range []string{settingsHome, dataDir, pending} {
		if directory == "" {
			continue
		}
		relative, e := filepath.Rel(settingsHome, directory)
		if e != nil || (!filepath.IsLocal(relative) && relative != ".") {
			rollback()
			return errors.New("saved data must remain inside the GameShelf data home")
		}
		for _, name := range names {
			source := filepath.Join(relative, name)
			if seen[source] {
				continue
			}
			seen[source] = true
			if _, e = home.Lstat(source); os.IsNotExist(e) {
				continue
			} else if e != nil {
				rollback()
				return e
			}
			destination := filepath.Join(stage, strconv.Itoa(len(moved)))
			if e = home.Rename(source, destination); e != nil {
				rollback()
				return e
			}
			moved = append(moved, movedPath{source, destination})
		}
	}
	if err = saveServerSettings(defaults); err != nil {
		rollback()
		return err
	}
	if err = home.RemoveAll(stage); err != nil {
		return errors.New("settings cleared, but old application data could not be completely removed; check data storage permissions")
	}
	return nil
}

func performGameOver(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	accessConfigMu.Lock()
	defer accessConfigMu.Unlock()
	if !checkAccess(w, r, resetAccessActions()) || !checkFreshPIN(w, r, []string{"wipe"}) {
		return
	}
	var confirmation struct {
		Confirm           string
		AcknowledgeBackup bool
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&confirmation) != nil || decoder.Decode(new(any)) != io.EOF || confirmation.Confirm != "WIPE" || !confirmation.AcknowledgeBackup {
		http.Error(w, "Confirm the backup reminder and Wipe before continuing.", 400)
		return
	}
	setupMu.Lock()
	defer setupMu.Unlock()
	libraryRuntimeMu.Lock()
	defer libraryRuntimeMu.Unlock()
	refreshMu.Lock()
	defer refreshMu.Unlock()
	profileMu.Lock()
	defer profileMu.Unlock()
	defaults := defaultServerSettings()
	defaults.DataDir = settingsHome
	defaults.SetupStatus = "pending"
	defaults.SetupCompleted = false
	defaults.Access = nil
	if err := wipeOwnedState(defaults); err != nil {
		http.Error(w, err.Error(), 503)
		return
	}
	profileCache = nil
	profileCacheHome = ""
	profileSessions = map[string]profileSession{}
	profileAttempts = map[string]pinBudget{}
	accessMu.Lock()
	accessSessions = map[string]*pinSession{}
	accessBudgets = map[string]pinBudget{}
	accessMu.Unlock()
	rootDir = ""
	rootDirs = nil
	dataDir = settingsHome
	setActiveSources(nil)
	cachedIDs = nil
	cachedIDRoot = ""
	cachedIDData = ""
	gamesMu.Lock()
	gamesMap = map[string]*gameEntry{}
	lastIndexedAt = time.Time{}
	gamesMu.Unlock()
	healthMu.Lock()
	healthData = healthArchive{Version: 1}
	healthHome = ""
	healthGeneration++
	healthMu.Unlock()
	applicationLogs.mu.Lock()
	applicationLogs.data = nil
	applicationLogs.mu.Unlock()
	setupRequired.Store(true)
	notifyRefreshSchedule()
	notifyHealthSchedule()
	for _, name := range []string{"gameshelf-family", "gameshelf-profile", "gameshelf-once"} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"wiped": true, "setupRequired": true})
}
