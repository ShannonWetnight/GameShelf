package main

import (
	"bytes"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

type accessRule struct {
	Mode   string `json:"mode"`
	Hidden bool   `json:"hidden"`
}
type accessPolicy struct {
	Rules map[string]accessRule `json:"rules"`
}

var accessActions = map[string]string{
	"sources": "Library Sources", "storage": "Saved data location", "refresh": "Refresh schedule", "logging": "Logging configuration", "logs": "View and export logs", "health": "Configure health monitoring", "healthView": "View Library Health", "export": "Export Data", "restore": "Restore Data", "wipe": "Wipe Settings", "setup": "First-Time Setup", "covers": "Edit covers and fit", "titles": "Edit game titles", "favoriteAdd": "Add favorites", "favoriteRemove": "Remove favorites", "metadata": "Reset Metadata", "playlistAdd": "Add to Playlist", "playlistRemove": "Remove or clear Playlist", "downloads": "Downloads",
}

var preferenceActions = map[string]string{"theme": "theme", "animation-speed": "motion", "animate-tiles": "tileAnimation", "show-hover-text": "buttonHints", "show-game-titles": "staticTitles", "show-placeholder-images": "placeholderArt", "card-depth": "cardDepth", "playlist-enabled": "playlistFeature", "show-list-images": "listImages", "favorites-first": "favoritesFirst", "favorite-stars-only": "pinnedStars", "hover-game-titles": "hoverNames", "list-opacity": "listOpacity", "recent-days": "recentRange", "recent-days-v2": "recentRange", "list-image-click": "imageExpand", "stretch-covers": "stretchDefault"}

func init() {
	for action, label := range map[string]string{"theme": "Theme", "motion": "Animation speed", "tileAnimation": "Loaded tile animation", "buttonHints": "Button hints", "staticTitles": "Static game titles", "placeholderArt": "Placeholder artwork", "cardDepth": "Card depth", "playlistFeature": "Enable Playlist downloads", "listImages": "List cover images", "favoritesFirst": "Favorites first", "pinnedStars": "Pinned favorite stars", "hoverNames": "Hover game names", "listOpacity": "List tile opacity", "recentRange": "Recently Added range", "imageExpand": "List image expansion", "stretchDefault": "Default cover stretching"} {
		accessActions[action] = label
	}
}
func resetAccessActions() []string {
	actions := []string{"wipe", "sources", "storage", "refresh", "logging", "health", "playlistRemove"}
	for _, action := range preferenceActions {
		actions = append(actions, action)
	}
	return actions
}

// The private record is authoritative even if ordinary settings are reset or corrupt.
// PBKDF2 parameters follow OWASP's SHA-256 guidance. No secret enters ZIP exports.
const pinIterations = 600000
const pinGrantDuration = 2 * time.Minute

type pinRecord struct {
	Version    int                   `json:"version"`
	Salt       string                `json:"salt"`
	Hash       string                `json:"hash"`
	Iterations int                   `json:"iterations"`
	Rules      map[string]accessRule `json:"rules"`
}
type pinSession struct {
	Home    string
	Expires time.Time
	Grants  map[string]time.Time
}
type pinBudget struct {
	Window   time.Time
	Attempts int
}

var accessMu sync.Mutex
var accessConfigMu sync.Mutex
var accessSessions = map[string]*pinSession{}
var accessBudgets = map[string]pinBudget{}

func pinPath() string { return filepath.Join(settingsHome, ".family-pin.json") }
func validPIN(pin string) bool {
	if len(pin) != 4 {
		return false
	}
	for _, digit := range pin {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}
func validateAccessPolicy(policy *accessPolicy) error {
	if policy == nil {
		return nil
	}
	if len(policy.Rules) > len(accessActions) {
		return errors.New("too many family-control rules")
	}
	for action, rule := range policy.Rules {
		if _, ok := accessActions[action]; !ok {
			return errors.New("unknown family-control action")
		}
		if rule.Mode != "allow" && rule.Mode != "pin" && rule.Mode != "disable" {
			return errors.New("choose Allow, Require PIN, or Disable")
		}
	}
	return nil
}
func readPINRecord() (*pinRecord, error) {
	file, err := os.Open(pinPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, 16385))
	if err != nil || len(contents) > 16384 {
		return nil, errors.New("PIN storage unavailable")
	}
	var record pinRecord
	if json.Unmarshal(contents, &record) != nil || record.Version != 1 || record.Iterations != pinIterations || validateAccessPolicy(&accessPolicy{record.Rules}) != nil {
		return nil, errors.New("PIN storage unavailable")
	}
	salt, e1 := base64.StdEncoding.DecodeString(record.Salt)
	hash, e2 := base64.StdEncoding.DecodeString(record.Hash)
	if e1 != nil || e2 != nil || len(salt) != 16 || len(hash) != 32 {
		return nil, errors.New("PIN storage unavailable")
	}
	return &record, nil
}
func savePrivateJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".private-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(append(data, '\n'))
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
func currentAccessPolicy() (*accessPolicy, bool, error) {
	record, err := readPINRecord()
	if err != nil {
		return nil, true, err
	}
	if record != nil {
		return &accessPolicy{record.Rules}, true, nil
	}
	settingsMu.RLock()
	value := configuredSettings.Access
	settingsMu.RUnlock()
	return value, false, nil
}
func publicAccessPolicy(fallback *accessPolicy) *accessPolicy {
	record, err := readPINRecord()
	if err == nil && record != nil {
		return &accessPolicy{record.Rules}
	}
	return fallback
}
func policyMode(policy *accessPolicy, action string) string {
	if policy != nil {
		if value := policy.Rules[action].Mode; value != "" {
			return value
		}
	}
	return "allow"
}
func pinCookie(r *http.Request) string {
	cookie, err := r.Cookie("gameshelf-family")
	if err != nil || len(cookie.Value) != 64 {
		return ""
	}
	return cookie.Value
}
func ensurePINSession(w http.ResponseWriter, r *http.Request) string {
	id := pinCookie(r)
	accessMu.Lock()
	defer accessMu.Unlock()
	now := time.Now()
	for key, session := range accessSessions {
		if now.After(session.Expires) {
			delete(accessSessions, key)
		}
	}
	if session := accessSessions[id]; session != nil && session.Home == settingsHome {
		session.Expires = now.Add(4 * time.Hour)
		return id
	}
	if len(accessSessions) >= 4096 {
		accessSessions = map[string]*pinSession{}
	}
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return ""
	}
	id = hex.EncodeToString(data)
	accessSessions[id] = &pinSession{settingsHome, now.Add(4 * time.Hour), map[string]time.Time{}}
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-family", Value: id, Path: "/", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
	return id
}
func hasPINGrant(r *http.Request, action string) bool {
	accessMu.Lock()
	defer accessMu.Unlock()
	session := accessSessions[pinCookie(r)]
	return session != nil && session.Home == settingsHome && time.Now().Before(session.Expires) && time.Now().Before(session.Grants[action])
}
func writeAccessError(w http.ResponseWriter, status int, code string, actions []string, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"code": code, "actions": actions, "message": message})
}
func checkAccess(w http.ResponseWriter, r *http.Request, actions []string) bool {
	policy, hasPIN, err := currentAccessPolicy()
	if err != nil {
		writeAccessError(w, 503, "access_unavailable", nil, "Family controls could not be read. Ask the server owner to check saved data.")
		return false
	}
	required := []string{}
	seen := map[string]bool{}
	for _, action := range actions {
		if seen[action] {
			continue
		}
		seen[action] = true
		mode := policyMode(policy, action)
		if action == "admin" {
			if !hasPIN {
				continue
			}
			mode = "pin"
		}
		if mode == "disable" {
			writeAccessError(w, 403, "action_disabled", []string{action}, accessActions[action]+" is disabled by family controls.")
			return false
		}
		if mode == "pin" && !hasPINGrant(r, action) {
			required = append(required, action)
		}
	}
	if len(required) > 0 {
		if !hasPIN {
			writeAccessError(w, 428, "pin_setup_required", required, "Create a new family PIN in Advanced Settings to activate restored family controls.")
		} else {
			writeAccessError(w, 423, "pin_required", required, "Enter the family PIN to continue.")
		}
		return false
	}
	return true
}
func accessRequestActions(r *http.Request) []string {
	path := r.URL.Path
	switch {
	case strings.HasPrefix(path, "/api/access"):
		return nil
	case path == "/api/server-settings/reset":
		return resetAccessActions()
	case path == "/api/server-settings" && r.Method == "PUT":
		contents, err := io.ReadAll(io.LimitReader(r.Body, 524289))
		r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(contents))
		if err != nil || len(contents) > 524288 {
			return []string{"sources", "storage", "refresh", "logging", "health"}
		}
		var value serverSettings
		if json.Unmarshal(contents, &value) != nil {
			return nil
		}
		settingsMu.RLock()
		old := configuredSettings
		settingsMu.RUnlock()
		actions := []string{}
		if !sourcesEqual(old.Sources, value.Sources) || !reflect.DeepEqual(libraryRoots(old), libraryRoots(value)) {
			actions = append(actions, "sources")
		}
		if old.DataDir != value.DataDir {
			actions = append(actions, "storage")
		}
		if old.RefreshInterval != value.RefreshInterval {
			actions = append(actions, "refresh")
		}
		if old.Verbose != value.Verbose || !reflect.DeepEqual(old.LogOptions, value.LogOptions) {
			actions = append(actions, "logging")
		}
		if !reflect.DeepEqual(normalizeHealthOptions(old.Health), normalizeHealthOptions(value.Health)) {
			actions = append(actions, "health")
		}
		keys := map[string]bool{}
		for key := range old.Preferences {
			keys[key] = true
		}
		for key := range value.Preferences {
			keys[key] = true
		}
		for key := range keys {
			if old.Preferences[key] != value.Preferences[key] {
				if action := preferenceActions[key]; action != "" {
					actions = append(actions, action)
				}
			}
		}
		return actions
	case path == "/api/library-restore" && r.URL.Query().Get("apply") == "1":
		actions := []string{"restore"}
		if r.URL.Query().Get("settings") == "1" {
			actions = append(actions, resetAccessActions()...)
		}
		if r.URL.Query().Get("state") == "1" {
			actions = append(actions, "titles", "covers", "favoriteAdd", "favoriteRemove", "metadata")
		}
		if r.URL.Query().Get("covers") == "1" {
			actions = append(actions, "covers")
		}
		if r.URL.Query().Get("health") == "1" {
			actions = append(actions, "health")
		}
		return actions
	case path == "/api/library-restore":
		return []string{"restore"}
	case path == "/api/library-backup":
		actions := []string{"export"}
		if r.URL.Query().Get("logs") == "1" {
			actions = append(actions, "logs")
		}
		if r.URL.Query().Get("health") == "1" {
			actions = append(actions, "healthView")
		}
		return actions
	case path == "/api/logs":
		return []string{"logs"}
	case strings.HasPrefix(path, "/api/health"):
		return []string{"healthView"}
	case path == "/api/setup" && r.Method == "POST":
		return []string{"setup", "sources", "storage", "refresh"}
	case path == "/api/setup/restart":
		return []string{"setup"}
	case path == "/api/network-test" || path == "/api/library-folders":
		return []string{"sources"}
	case strings.HasPrefix(path, "/api/covers/") || strings.HasPrefix(path, "/api/cover-fit/"):
		return []string{"covers"}
	case strings.HasPrefix(path, "/api/game-title/"):
		return []string{"titles"}
	case strings.HasPrefix(path, "/api/favorite/"):
		contents, _ := io.ReadAll(io.LimitReader(r.Body, 4097))
		r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(contents))
		var value struct {
			Favorite bool `json:"favorite"`
		}
		json.Unmarshal(contents, &value)
		if value.Favorite {
			return []string{"favoriteAdd"}
		}
		return []string{"favoriteRemove"}
	case strings.HasPrefix(path, "/api/metadata-reset/"):
		contents, _ := io.ReadAll(io.LimitReader(r.Body, 4097))
		r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(contents))
		var value metadataResetRequest
		json.Unmarshal(contents, &value)
		actions := []string{"metadata"}
		if value.Title {
			actions = append(actions, "titles")
		}
		if value.Cover {
			actions = append(actions, "covers")
		}
		if value.Favorite {
			actions = append(actions, "favoriteRemove")
		}
		return actions
	case strings.HasPrefix(path, "/download") || strings.HasPrefix(path, "/api/game-file/"):
		return []string{"downloads"}
	case path == "/api/settings-events":
		contents, _ := io.ReadAll(io.LimitReader(r.Body, 8193))
		r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(contents))
		var values map[string]string
		json.Unmarshal(contents, &values)
		actions := []string{}
		for key := range values {
			if action := preferenceActions[key]; action != "" {
				actions = append(actions, action)
			}
		}
		return actions
	}
	return nil
}
func accessGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Authorize exactly one JSON document, matching the handler's input.
		// In particular, a valid first object followed by junk must never skip
		// classification and then be accepted by a streaming decoder downstream.
		path := r.URL.Path
		jsonBody := r.Method != "GET" && r.Method != "HEAD" && (path == "/api/server-settings" || path == "/api/settings-events" || path == "/api/access" || path == "/api/access/unlock" || strings.HasPrefix(path, "/api/favorite/") || strings.HasPrefix(path, "/api/metadata-reset/"))
		if jsonBody && r.Method != "DELETE" {
			contents, err := io.ReadAll(io.LimitReader(r.Body, 524289))
			r.Body.Close()
			if err != nil || len(contents) > 524288 {
				http.Error(w, "request body exceeds limit", 413)
				return
			}
			if !json.Valid(contents) {
				http.Error(w, "send one valid JSON document", 400)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(contents))
		}
		actions := accessRequestActions(r)
		if len(actions) > 0 && !checkAccess(w, r, actions) {
			return
		}
		next.ServeHTTP(w, r)
	})
}
func allowPINAttempt(r *http.Request) bool {
	accessMu.Lock()
	defer accessMu.Unlock()
	now := time.Now()
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	keys := []string{settingsHome + "|" + ip, settingsHome + "|*"}
	for key, budget := range accessBudgets {
		if now.Sub(budget.Window) >= time.Minute {
			delete(accessBudgets, key)
		}
	}
	if len(accessBudgets) > 4096 {
		return false
	}
	for index, key := range keys {
		budget := accessBudgets[key]
		limit := 6
		if index == 1 {
			limit = 30
		}
		if now.Sub(budget.Window) < time.Minute && budget.Attempts >= limit {
			return false
		}
	}
	for _, key := range keys {
		budget := accessBudgets[key]
		if now.Sub(budget.Window) >= time.Minute {
			budget = pinBudget{Window: now}
		}
		budget.Attempts++
		accessBudgets[key] = budget
	}
	return true
}
func handleAccessUnlock(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var request struct {
		PIN     string   `json:"pin"`
		Actions []string `json:"actions"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || !validPIN(request.PIN) || len(request.Actions) == 0 || len(request.Actions) > len(accessActions)+1 {
		http.Error(w, "Enter a four-digit PIN.", 400)
		return
	}
	for _, action := range request.Actions {
		if _, ok := accessActions[action]; !ok && action != "admin" {
			http.Error(w, "unknown action", 400)
			return
		}
	}
	if !allowPINAttempt(r) {
		w.Header().Set("Retry-After", "60")
		writeAccessError(w, 429, "pin_rate_limited", nil, "Too many PIN attempts. Wait one minute and try again.")
		return
	}
	record, err := readPINRecord()
	if err != nil {
		http.Error(w, "PIN storage is unavailable.", 503)
		return
	}
	if record == nil {
		http.Error(w, "Create a family PIN first.", 409)
		return
	}
	salt, _ := base64.StdEncoding.DecodeString(record.Salt)
	expected, _ := base64.StdEncoding.DecodeString(record.Hash)
	actual, err := pbkdf2.Key(sha256.New, request.PIN, salt, record.Iterations, 32)
	if err != nil || subtle.ConstantTimeCompare(actual, expected) != 1 {
		logEvent("errors", "Family PIN attempt rejected")
		writeAccessError(w, 401, "pin_incorrect", nil, "That PIN did not match. Try again.")
		return
	}
	id := ensurePINSession(w, r)
	if id == "" {
		http.Error(w, "Could not unlock this action.", 503)
		return
	}
	until := time.Now().Add(pinGrantDuration)
	accessMu.Lock()
	for _, action := range request.Actions {
		accessSessions[id].Grants[action] = until
	}
	accessMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"unlocked": request.Actions, "expiresAt": until})
	logEvent("system", "Family PIN accepted for %d action(s)", len(request.Actions))
}
func handleAccess(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == "GET" {
		policy, configured, err := currentAccessPolicy()
		if err != nil {
			http.Error(w, "Family controls unavailable.", 503)
			return
		}
		id := ensurePINSession(w, r)
		grants := map[string]time.Time{}
		accessMu.Lock()
		if session := accessSessions[id]; session != nil {
			for action, until := range session.Grants {
				if time.Now().Before(until) {
					grants[action] = until
				}
			}
		}
		accessMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"configured": configured, "policy": policy, "actions": accessActions, "grants": grants})
		return
	}
	if r.Method != "PUT" && r.Method != "DELETE" {
		http.Error(w, "method not allowed", 405)
		return
	}
	if !checkAccess(w, r, []string{"admin"}) {
		return
	}
	accessConfigMu.Lock()
	defer accessConfigMu.Unlock()
	if !checkAccess(w, r, []string{"admin"}) {
		return
	}
	setupMu.Lock()
	defer setupMu.Unlock()
	oldRecord, err := readPINRecord()
	if err != nil {
		http.Error(w, "Family controls unavailable.", 503)
		return
	}
	settingsMu.RLock()
	value := configuredSettings
	settingsMu.RUnlock()
	oldPolicy := value.Access
	if r.Method == "DELETE" {
		value.Access = nil
		if err := saveServerSettings(value); err != nil {
			http.Error(w, "Could not remove family controls.", 503)
			return
		}
		if err := os.Remove(pinPath()); err != nil && !os.IsNotExist(err) {
			value.Access = oldPolicy
			saveServerSettings(value)
			http.Error(w, "Could not remove the PIN.", 503)
			return
		}
		accessMu.Lock()
		accessSessions = map[string]*pinSession{}
		accessMu.Unlock()
		logEvent("system", "Family controls removed")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("{\"saved\":true}"))
		return
	}
	var request struct {
		NewPIN string       `json:"newPin"`
		Policy accessPolicy `json:"policy"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || validateAccessPolicy(&request.Policy) != nil {
		http.Error(w, "Invalid family-control options.", 400)
		return
	}
	if oldRecord == nil && !validPIN(request.NewPIN) || request.NewPIN != "" && !validPIN(request.NewPIN) {
		http.Error(w, "Choose a four-digit PIN.", 400)
		return
	}
	record := oldRecord
	if record == nil {
		record = &pinRecord{Version: 1, Iterations: pinIterations}
	} else {
		copy := *record
		record = &copy
	}
	if request.NewPIN != "" {
		salt := make([]byte, 16)
		if _, err := rand.Read(salt); err != nil {
			http.Error(w, "Could not create PIN.", 503)
			return
		}
		hash, err := pbkdf2.Key(sha256.New, request.NewPIN, salt, pinIterations, 32)
		if err != nil {
			http.Error(w, "Could not create PIN.", 503)
			return
		}
		record.Salt = base64.StdEncoding.EncodeToString(salt)
		record.Hash = base64.StdEncoding.EncodeToString(hash)
	}
	record.Rules = request.Policy.Rules
	if err := savePrivateJSON(pinPath(), record); err != nil {
		http.Error(w, "Could not save family controls.", 503)
		return
	}
	value.Access = &request.Policy
	if err := saveServerSettings(value); err != nil {
		if oldRecord != nil {
			savePrivateJSON(pinPath(), oldRecord)
		} else {
			os.Remove(pinPath())
		}
		http.Error(w, "Could not save family controls.", 503)
		return
	}
	id := ensurePINSession(w, r)
	accessMu.Lock()
	for _, session := range accessSessions {
		session.Grants = map[string]time.Time{}
	}
	if session := accessSessions[id]; session != nil {
		session.Grants["admin"] = time.Now().Add(pinGrantDuration)
	}
	accessMu.Unlock()
	logEvent("system", "Family-control policy saved")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"saved": true, "configured": true})
}
func sortedAccessActions() []string {
	keys := make([]string, 0, len(accessActions))
	for key := range accessActions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
