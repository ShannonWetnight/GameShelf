package main

import (
	"bytes"
	"context"
	"crypto/rand"
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
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type accessRule struct {
	Mode   string `json:"mode"`
	Hidden bool   `json:"hidden"`
	Level  string `json:"level,omitempty"`
}
type pinRemembrance struct {
	Enabled bool `json:"enabled"`
	Minutes int  `json:"minutes"`
}
type accessPolicy struct {
	Rules    map[string]accessRule `json:"rules"`
	Remember *pinRemembrance       `json:"remember,omitempty"`
}

func remembrance(value *pinRemembrance) pinRemembrance {
	if value == nil {
		return pinRemembrance{Enabled: true, Minutes: 5}
	}
	return *value
}

var accessActions = map[string]string{
	"admin": "Family Controls", "settings": "Settings menu", "advanced": "Advanced settings tab", "libraryManager": "Library Manager", "sources": "Library Sources", "storage": "Saved data location", "refresh": "Refresh Interval", "logging": "Logging configuration", "logs": "View and export logs", "health": "Configure health monitoring", "healthView": "View Library Health", "export": "Export Data", "restore": "Restore Data", "wipe": "Wipe GameShelf", "setup": "First-Time Setup", "covers": "Edit covers and fit", "titles": "Edit game titles", "favoriteAdd": "Add favorites", "favoriteRemove": "Remove favorites", "metadata": "Reset Metadata", "playlistAdd": "Add to Playlist", "playlistRemove": "Remove or clear Playlist", "downloads": "Downloads",
}

var preferenceActions = map[string]string{"theme": "theme", "animation-speed": "motion", "ui-scale": "uiScale", "dynamic-scale": "uiScale", "animate-tiles": "tileAnimation", "show-hover-text": "buttonHints", "show-game-titles": "staticTitles", "show-placeholder-images": "placeholderArt", "card-depth": "cardDepth", "playlist-enabled": "playlistFeature", "show-list-images": "listImages", "favorites-first": "favoritesFirst", "favorite-stars-only": "pinnedStars", "hover-game-titles": "hoverNames", "list-opacity": "listOpacity", "recent-days": "recentRange", "recent-days-v2": "recentRange", "list-image-click": "imageExpand", "stretch-covers": "stretchDefault"}

func init() {
	for action, label := range map[string]string{"theme": "Theme", "motion": "Animation speed", "uiScale": "UI scale", "tileAnimation": "Loaded tile animation", "buttonHints": "Button hints", "staticTitles": "Static game titles", "placeholderArt": "Placeholder artwork", "cardDepth": "Card depth", "playlistFeature": "Enable Playlist downloads", "listImages": "List cover images", "favoritesFirst": "Favorites first", "pinnedStars": "Pinned favorite stars", "hoverNames": "Hover game names", "listOpacity": "List tile opacity", "recentRange": "Recently Added range", "imageExpand": "List image expansion", "stretchDefault": "Default cover stretching"} {
		accessActions[action] = label
	}
}

var accessDefaultLevels = map[string]string{
	"theme": "basic", "buttonHints": "basic", "staticTitles": "basic", "placeholderArt": "basic", "playlistFeature": "basic", "listImages": "basic", "favoritesFirst": "basic", "pinnedStars": "basic", "export": "basic", "restore": "basic", "logs": "basic", "setup": "basic",
	"uiScale": "advanced", "motion": "advanced", "tileAnimation": "advanced", "cardDepth": "advanced", "stretchDefault": "advanced", "hoverNames": "advanced", "listOpacity": "advanced", "recentRange": "advanced", "imageExpand": "advanced", "libraryManager": "advanced", "logging": "advanced", "wipe": "advanced", "admin": "advanced",
}

func accessLevel(policy *accessPolicy, action string) string {
	if policy != nil && policy.Rules[action].Level != "" {
		return policy.Rules[action].Level
	}
	return accessDefaultLevels[action]
}
func accessGroup(action string) string {
	switch action {
	case "settings", "advanced":
		return "Settings access"
	case "theme", "uiScale", "motion", "tileAnimation", "buttonHints", "staticTitles", "placeholderArt", "cardDepth":
		return "Appearance"
	case "stretchDefault", "playlistFeature", "listImages", "favoritesFirst", "pinnedStars", "hoverNames", "listOpacity", "recentRange", "imageExpand":
		return "Library View"
	case "libraryManager", "sources", "storage", "refresh", "health", "healthView":
		return "Library Manager"
	case "export", "restore", "logging", "logs", "setup", "wipe", "admin":
		return "Data and Diagnostics"
	default:
		return "Game actions"
	}
}
func accessDependencies(policy *accessPolicy, actions []string, settingsOperation bool) []string {
	result := append([]string(nil), actions...)
	if settingsOperation {
		result = append(result, "settings")
	}
	for _, action := range actions {
		switch action {
		case "sources", "storage", "refresh", "health", "healthView":
			result = append(result, "libraryManager")
			if settingsOperation && accessLevel(policy, "libraryManager") == "advanced" {
				result = append(result, "advanced")
			}
		}
		if settingsOperation && accessLevel(policy, action) == "advanced" {
			result = append(result, "advanced")
		}
	}
	unique := make([]string, 0, len(result))
	seen := map[string]bool{}
	for _, action := range result {
		if !seen[action] {
			seen[action] = true
			unique = append(unique, action)
		}
	}
	return unique
}

func resetAccessActions() []string {
	actions := []string{"wipe", "admin", "sources", "storage", "refresh", "logging", "health", "playlistRemove", "covers", "titles", "metadata", "favoriteRemove"}
	for _, action := range preferenceActions {
		if !slices.Contains(actions, action) {
			actions = append(actions, action)
		}
	}
	return actions
}

// The private record is authoritative even if ordinary settings are reset or corrupt.
// PBKDF2 parameters follow OWASP's SHA-256 guidance. No secret enters ZIP exports.
const pinIterations = 600000

type pinRecord struct {
	PrimaryDisabled bool                  `json:"primaryDisabled,omitempty"`
	GuardianName    string                `json:"guardianName,omitempty"`
	Secondary       *guardianCredential   `json:"secondary,omitempty"`
	Version         int                   `json:"version"`
	Salt            string                `json:"salt"`
	Hash            string                `json:"hash"`
	Iterations      int                   `json:"iterations"`
	Rules           map[string]accessRule `json:"rules"`
	Remember        *pinRemembrance       `json:"remember,omitempty"`
}
type pinSession struct {
	GuardianID string
	Home       string
	Expires    time.Time
	Grants     map[string]time.Time
	Epoch      uint64
	Permits    map[string]pinPermit
	Menus      map[string]menuLease
}
type pinPermit struct {
	Actions map[string]bool
	Expires time.Time
}
type pinRequestKey struct{}
type pinApproval struct {
	Session *pinSession
	Epoch   uint64
	Actions map[string]bool
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
	if policy.Remember != nil && (policy.Remember.Minutes < 1 || policy.Remember.Minutes > 60) {
		return errors.New("PIN remembrance must be 1-60 minutes")
	}
	if len(policy.Rules) > len(accessActions) {
		return errors.New("too many family-control rules")
	}
	for action, rule := range policy.Rules {
		if _, ok := accessActions[action]; !ok {
			return errors.New("unknown family-control action")
		}
		if rule.Level != "" && rule.Level != "basic" && rule.Level != "advanced" {
			return errors.New("choose Basic or Advanced for the setting category")
		}
		if (action == "settings" || action == "advanced") && (rule.Mode == "disable" || rule.Hidden) {
			return errors.New("menu gates support Allow or Require PIN and must stay visible")
		}
		if action == "admin" && (rule.Hidden || (rule.Mode != "pin" && rule.Mode != "guardian" && rule.Mode != "allow")) {
			return errors.New("Family Controls must remain visible and require the Guardian PIN")
		}
		if rule.Mode != "allow" && rule.Mode != "pin" && rule.Mode != "guardian" && rule.Mode != "disable" {
			return errors.New("choose Allow, Require PIN, Guardian PIN, or Disable")
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
	if json.Unmarshal(contents, &record) != nil || record.Version != 1 || record.Iterations != pinIterations || validateAccessPolicy(&accessPolicy{Rules: record.Rules, Remember: record.Remember}) != nil {
		return nil, errors.New("PIN storage unavailable")
	}
	salt, e1 := base64.StdEncoding.DecodeString(record.Salt)
	hash, e2 := base64.StdEncoding.DecodeString(record.Hash)
	if e1 != nil || e2 != nil || len(salt) != 16 || len(hash) != 32 {
		return nil, errors.New("PIN storage unavailable")
	}
	if record.Secondary != nil && (record.Secondary.ID != "guardian-2" || !validGuardianCredential(*record.Secondary)) {
		return nil, errors.New("PIN storage unavailable")
	}
	if record.PrimaryDisabled && record.Secondary == nil {
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
		return &accessPolicy{Rules: record.Rules, Remember: record.Remember}, true, nil
	}
	settingsMu.RLock()
	value := configuredSettings.Access
	settingsMu.RUnlock()
	return value, false, nil
}
func publicAccessPolicy(fallback *accessPolicy) *accessPolicy {
	record, err := readPINRecord()
	if err == nil && record != nil {
		return &accessPolicy{Rules: record.Rules, Remember: record.Remember}
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
	accessSessions[id] = &pinSession{Home: settingsHome, Expires: now.Add(4 * time.Hour), Grants: map[string]time.Time{}, Permits: map[string]pinPermit{}}
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-family", Value: id, Path: "/", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
	replaceRequestCookie(r, "gameshelf-family", id)
	return id
}
func hasPINGrant(r *http.Request, action string) bool {
	accessMu.Lock()
	defer accessMu.Unlock()
	session := accessSessions[pinCookie(r)]
	return pinAuthorityAllows(session, r, action) && session.Home == settingsHome && time.Now().Before(session.Expires) && (time.Now().Before(session.Grants[action]) || menuAuthorized(session, r, action))
}
func usePINPermit(w http.ResponseWriter, r *http.Request, actions []string) bool {
	if approved, ok := r.Context().Value(pinRequestKey{}).(pinApproval); ok {
		accessMu.Lock()
		defer accessMu.Unlock()
		session := accessSessions[pinCookie(r)]
		if session != approved.Session || !guardianSessionAllowed(session, r) || session.Epoch != approved.Epoch || time.Now().After(session.Expires) {
			return false
		}
		for _, action := range actions {
			if !approved.Actions[action] || !pinAuthorityAllows(session, r, action) {
				return false
			}
		}
		return true
	}
	token := r.Header.Get("X-GameShelf-PIN")
	if token == "" {
		if cookie, e := r.Cookie("gameshelf-once"); e == nil {
			token = cookie.Value
		}
	}
	if len(token) != 64 {
		return false
	}
	accessMu.Lock()
	defer accessMu.Unlock()
	session := accessSessions[pinCookie(r)]
	if !guardianSessionAllowed(session, r) || session.Home != settingsHome || time.Now().After(session.Expires) {
		return false
	}
	permit, ok := session.Permits[token]
	if !ok || time.Now().After(permit.Expires) {
		return false
	}
	for _, action := range actions {
		if !permit.Actions[action] || !pinAuthorityAllows(session, r, action) {
			return false
		}
	}
	delete(session.Permits, token)
	*r = *r.WithContext(context.WithValue(r.Context(), pinRequestKey{}, pinApproval{session, session.Epoch, permit.Actions}))
	w.Header().Set("X-GameShelf-PIN-Consumed", "true")
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-once", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
	return true
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
	policy = combinedAccessPolicy(r, policy)
	wipeApproved := r.URL.Path == "/api/server-settings/reset" && hasWipeLease(r)
	// Imported PIN rules carry no authority until a Guardian credential exists.
	// Do not require creating a PIN merely to erase an unprotected shelf.
	withoutPINWipe := !hasPIN && (r.URL.Path == "/api/server-settings/reset" || r.Context().Value(wipeEntryKey{}) == true)
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
			mode = "guardian"
		}
		if action == "wipe" && mode != "disable" && hasPIN {
			mode = "guardian"
		}
		if mode == "disable" {
			writeAccessError(w, 403, "action_disabled", []string{action}, accessActions[action]+" has been disabled by a GameShelf Guardian.")
			return false
		}
		if (mode == "pin" || mode == "guardian") && !withoutPINWipe && !wipeApproved && !hasPINGrant(r, action) {
			required = append(required, action)
		}
	}
	if len(required) > 0 && hasPIN && usePINPermit(w, r, required) {
		return true
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
	case path == "/api/setup" && r.Method == "POST" && r.URL.Query().Get("draft") == "1":
		return []string{"admin", "sources"}
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
		if r.URL.Query().Get("profiles") == "1" {
			actions = append(actions, "admin")
		}
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
		if r.URL.Query().Get("profiles") == "1" {
			actions = append(actions, "admin")
		}
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
		jsonBody := r.Method != "GET" && r.Method != "HEAD" && (path == "/api/server-settings" || path == "/api/settings-events" || path == "/api/access" || path == "/api/access/unlock" || path == "/api/access/enter" || path == "/api/access/leave" || strings.HasPrefix(path, "/api/favorite/") || strings.HasPrefix(path, "/api/metadata-reset/"))
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
		settingsOperation := r.URL.Path == "/api/server-settings" && r.Method == "PUT" || r.URL.Path == "/api/settings-events" && len(actions) > 0 || r.URL.Path == "/api/server-settings/reset" || r.URL.Path == "/api/library-backup" || r.URL.Path == "/api/library-restore" || r.URL.Path == "/api/logs" || strings.HasPrefix(r.URL.Path, "/api/health") || r.URL.Path == "/api/network-test" || r.URL.Path == "/api/library-folders" || r.URL.Path == "/api/setup/restart"
		if len(actions) > 0 || settingsOperation {
			policy, _, _ := currentAccessPolicy()
			actions = accessDependencies(combinedAccessPolicy(r, policy), actions, settingsOperation)
		}
		if len(actions) > 0 && !checkAccess(w, r, actions) {
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && len(actions) > 0 && !strings.HasPrefix(path, "/api/access") {
			reply := &auditReply{ResponseWriter: w}
			next.ServeHTTP(reply, r)
			if reply.status < 400 {
				auditProfile(r, "Changed "+strings.Join(actions, ", "))
			}
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
		PIN      string   `json:"pin"`
		Actions  []string `json:"actions"`
		Remember bool     `json:"remember"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || !validPIN(request.PIN) || len(request.Actions) == 0 || len(request.Actions) > len(accessActions)+1 {
		http.Error(w, "Enter a 4-digit PIN.", 400)
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
	accessConfigMu.Lock()
	defer accessConfigMu.Unlock()
	record, err := readPINRecord()
	if err != nil {
		http.Error(w, "PIN storage is unavailable.", 503)
		return
	}
	if record == nil {
		http.Error(w, "Create a family PIN first.", 409)
		return
	}
	matched := matchGuardianPIN(record, request.PIN, guardianConstraint(r))
	if matched == "" {
		if view := profileView(r); view != nil && !view.Profile.UsesGuardianPIN && profileRequiresPIN(view.Profile) && profilePINMatches(view.Profile, request.PIN) {
			personal := true
			for _, action := range request.Actions {
				if requiresGuardianPIN(r, action) {
					personal = false
				}
			}
			if personal {
				matched = "user:" + view.Profile.ID
			}
		}
	}
	if matched == "" {
		logEvent("profile", "Guardian PIN attempt rejected")
		writeAccessError(w, 401, "pin_incorrect", nil, "That PIN did not match. Try again.")
		return
	}
	id := ensurePINSession(w, r)
	if id == "" {
		http.Error(w, "Could not unlock this action.", 503)
		return
	}
	options := remembrance(record.Remember)
	until := time.Now().Add(time.Duration(options.Minutes) * time.Minute)
	remembered := request.Remember && options.Enabled
	for _, action := range request.Actions {
		if action == "wipe" {
			remembered = false
		}
	}
	token := ""
	accessMu.Lock()
	if accessSessions[id].GuardianID != matched {
		accessSessions[id].Grants = map[string]time.Time{}
		accessSessions[id].Menus = nil
		accessSessions[id].Permits = nil
		accessSessions[id].Epoch++
	}
	accessSessions[id].GuardianID = matched
	if remembered {
		for _, action := range request.Actions {
			accessSessions[id].Grants[action] = until
		}
	} else {
		data := make([]byte, 32)
		if _, err := rand.Read(data); err != nil {
			accessMu.Unlock()
			http.Error(w, "Could not unlock this action.", 503)
			return
		}
		token = hex.EncodeToString(data)
		http.SetCookie(w, &http.Cookie{Name: "gameshelf-once", Value: token, Path: "/", MaxAge: 60, HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
		until = time.Now().Add(time.Minute)
		session := accessSessions[id]
		if session.Permits == nil {
			session.Permits = map[string]pinPermit{}
		}
		for key, permit := range session.Permits {
			if time.Now().After(permit.Expires) {
				delete(session.Permits, key)
			}
		}
		if len(session.Permits) >= 32 {
			session.Permits = map[string]pinPermit{}
		}
		actions := map[string]bool{}
		for _, action := range request.Actions {
			actions[action] = true
		}
		session.Permits[token] = pinPermit{Actions: actions, Expires: until}
	}
	accessMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"unlocked": request.Actions, "expiresAt": until, "remembered": remembered, "token": token})
	logEvent("profile", "%s authenticated for %d action(s)", matched, len(request.Actions))
}
func handleAccess(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == "GET" {
		policy, configured, err := currentAccessPolicy()
		if err != nil {
			http.Error(w, "Family controls unavailable.", 503)
			return
		}
		if r.URL.Query().Get("manage") == "1" {
			if !checkAccess(w, r, []string{"admin"}) {
				return
			}
		} else {
			policy = combinedAccessPolicy(r, policy)
		}
		id := ensurePINSession(w, r)
		grants := map[string]time.Time{}
		accessMu.Lock()
		if session := accessSessions[id]; guardianSessionAllowed(session, r) {
			for action, until := range session.Grants {
				if time.Now().Before(until) && pinAuthorityAllows(session, r, action) {
					grants[action] = until
				}
			}
		}
		accessMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"guardians": publicGuardians(), "configured": configured, "policy": policy, "actions": accessActions, "levels": accessDefaultLevels, "groups": func() map[string]string {
			groups := map[string]string{}
			for action := range accessActions {
				groups[action] = accessGroup(action)
			}
			return groups
		}(), "grants": grants, "personalPIN": profileView(r) != nil && profileRequiresPIN(profileView(r).Profile)})
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
		if r.URL.Query().Get("guardianID") != "" {
			removeGuardianCredential(w, r, oldRecord, value)
			return
		}
		profileMu.Lock()
		db, profileErr := readProfileDBLocked()
		enabled := profileErr != nil || db.Enabled
		profileMu.Unlock()
		if enabled {
			http.Error(w, "Turn off family profiles before removing the Guardian PIN.", 409)
			return
		}
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
		NewPIN       string       `json:"newPin"`
		GuardianID   string       `json:"guardianID"`
		GuardianName string       `json:"guardianName"`
		AutoProfile  bool         `json:"autoProfile"`
		Policy       accessPolicy `json:"policy"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || validateAccessPolicy(&request.Policy) != nil {
		http.Error(w, "Invalid family-control options.", 400)
		return
	}
	if oldRecord == nil && request.NewPIN == "" {
		for action, rule := range request.Policy.Rules {
			if rule.Mode == "pin" || rule.Mode == "guardian" && action != "wipe" {
				writeAccessError(w, 428, "pin_setup_required", nil, "An item requiring a PIN has been selected, but no PIN has been set.")
				return
			}
		}
		value.Access = &request.Policy
		if saveServerSettings(value) != nil {
			http.Error(w, "Could not save family controls.", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("{\"saved\":true,\"configured\":false}"))
		return
	}
	if oldRecord == nil && !validPIN(request.NewPIN) || request.NewPIN != "" && !validPIN(request.NewPIN) {
		http.Error(w, "Choose a 4-digit PIN.", 400)
		return
	}
	record := oldRecord
	addingGuardian := false
	if oldRecord != nil && request.NewPIN != "" {
		_, exists := guardianCredentialByID(oldRecord, request.GuardianID)
		addingGuardian = !exists
	}
	if oldRecord != nil && request.NewPIN == "" && request.GuardianID != "" {
		if _, ok := guardianCredentialByID(oldRecord, request.GuardianID); !ok {
			http.Error(w, "Enter and confirm a new 4-digit PIN for this Guardian.", 400)
			return
		}
	}
	if record == nil {
		record = &pinRecord{Version: 1, Iterations: pinIterations}
	} else {
		copy := *record
		record = &copy
	}
	if request.NewPIN != "" {
		if err := setGuardianCredential(record, request.GuardianID, request.NewPIN); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}
	if request.GuardianName != "" {
		name := strings.TrimSpace(request.GuardianName)
		if !validProfileName(name) {
			http.Error(w, "Choose a Guardian nickname of up to 60 characters.", 400)
			return
		}
		if guardianID(request.GuardianID) == "guardian-1" {
			record.GuardianName = name
		} else if record.Secondary != nil {
			secondary := *record.Secondary
			secondary.Name = name
			record.Secondary = &secondary
		} else {
			http.Error(w, "Create this Guardian PIN before naming it.", 400)
			return
		}
	}

	if request.Policy.Rules == nil {
		request.Policy.Rules = map[string]accessRule{}
	}
	admin := request.Policy.Rules["admin"]
	admin.Mode = "guardian"
	admin.Hidden = false
	request.Policy.Rules["admin"] = admin
	record.Rules = request.Policy.Rules
	record.Remember = request.Policy.Remember
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
	ensurePINSession(w, r)
	accessMu.Lock()
	for _, session := range accessSessions {
		session.Grants = map[string]time.Time{}
		session.Permits = map[string]pinPermit{}
		session.Menus = nil
		session.Epoch++
	}
	if oldRecord != nil && request.NewPIN != "" && !addingGuardian {
		accessSessions = map[string]*pinSession{}
		http.SetCookie(w, &http.Cookie{Name: "gameshelf-family", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	}
	accessMu.Unlock()
	if request.NewPIN != "" {
		revokeGuardianProfiles()
	}
	auditProfile(r, "Guardian controls saved")
	w.Header().Set("Content-Type", "application/json")
	if oldRecord == nil || request.NewPIN == "" || addingGuardian {
		id := ensurePINSession(w, r)
		accessMu.Lock()
		session := accessSessions[id]
		if session != nil {
			if oldRecord == nil {
				session.GuardianID = "guardian-1"
			}
		}
		accessMu.Unlock()
		issueInitialGuardianLease(w, r)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"saved": true, "configured": true, "created": false})
}
func sortedAccessActions() []string {
	keys := make([]string, 0, len(accessActions))
	for key := range accessActions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type wipeEntryKey struct{}

func handleAccessEnter(w http.ResponseWriter, r *http.Request) {
	// Serialize approval-to-lease promotion with PIN rotation and policy revocation.
	accessConfigMu.Lock()
	defer accessConfigMu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var value struct {
		Action string
		Level  string
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		http.Error(w, "unknown menu", 400)
		return
	}
	if _, known := accessActions[value.Action]; !known {
		http.Error(w, "unknown menu", 400)
		return
	}
	actions := []string{value.Action}
	if value.Action == "wipe" {
		actions = resetAccessActions()
		r = r.WithContext(context.WithValue(r.Context(), wipeEntryKey{}, true))
	}
	if value.Action == "advanced" || value.Action == "settings" && value.Level == "advanced" {
		actions = append(actions, "settings", "advanced")
	}
	if value.Action != "admin" && value.Action != "covers" && isMenuScope(value.Action) && value.Action != "settings" && value.Action != "advanced" {
		policy, _, _ := currentAccessPolicy()
		actions = accessDependencies(combinedAccessPolicy(r, policy), actions, true)
	}
	if value.Action == "wipe" {
		if _, configured, _ := currentAccessPolicy(); configured && !hasWipeLease(r) && !checkFreshPIN(w, r, actions) {
			return
		}
	}
	if !checkAccess(w, r, actions) {
		return
	}
	if isMenuScope(value.Action) {
		if value.Action == "wipe" {
			actions = []string{"wipe"}
		}
		issueMenuLease(w, r, actions)
		return
	}
	w.WriteHeader(204)
}
