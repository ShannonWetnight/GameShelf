package main

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type familyRole struct {
	ID       string                `json:"id"`
	Name     string                `json:"name"`
	Template string                `json:"template,omitempty"`
	Rules    map[string]accessRule `json:"rules"`
}
type familyGroup struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Roles []string `json:"roles"`
}
type familyProfile struct {
	ID                 string            `json:"id"`
	Nickname           string            `json:"nickname"`
	Avatar             string            `json:"avatar,omitempty"`
	GuardianID         string            `json:"guardianID,omitempty"`
	Hidden             bool              `json:"hidden,omitempty"`
	ForcePINChange     bool              `json:"forcePINChange,omitempty"`
	UsesGuardianPIN    bool              `json:"usesGuardianPIN,omitempty"`
	TourPending        bool              `json:"tourPending,omitempty"`
	PINRequired        *bool             `json:"pinRequired,omitempty"`
	Roles              []string          `json:"roles"`
	EffectiveRoles     []string          `json:"effectiveRoles,omitempty"`
	Groups             []string          `json:"groups,omitempty"`
	AllowMultipleRoles bool              `json:"allowMultipleRoles,omitempty"`
	UnprotectedAdmin   bool              `json:"unprotectedAdmin,omitempty"`
	HasSavedPIN        bool              `json:"hasSavedPIN,omitempty"`
	AllLibraries       bool              `json:"allLibraries"`
	Libraries          []string          `json:"libraries"`
	AllGames           bool              `json:"allGames"`
	Games              []string          `json:"games"`
	Preferences        map[string]string `json:"preferences"`
	Favorites          map[string]bool   `json:"favorites"`
	Salt               string            `json:"salt,omitempty"`
	Hash               string            `json:"hash,omitempty"`
}
type profileDatabase struct {
	Version          int                      `json:"version"`
	Enabled          bool                     `json:"enabled"`
	Epoch            uint64                   `json:"epoch"`
	Roles            map[string]familyRole    `json:"roles"`
	Groups           map[string]familyGroup   `json:"groups,omitempty"`
	SelectionVersion int                      `json:"selectionVersion,omitempty"`
	Profiles         map[string]familyProfile `json:"profiles"`
}
type profileSession struct {
	Home, Profile string
	Guardian      bool
	Epoch         uint64
	Until         time.Time
}
type profileContext struct {
	Profile familyProfile
	Rules   map[string]accessRule
	Epoch   uint64
}
type profileContextKey struct{}

var profileMu sync.Mutex
var profileSessions = map[string]profileSession{}
var profileAttempts = map[string]pinBudget{}
var profileCache *profileDatabase
var profileCacheHome string
var profileCacheStamp time.Time
var profileCacheSize int64

const maxProfileData = 32 << 20

func profilePath() string { return filepath.Join(settingsHome, ".family-profiles.json") }
func defaultProfileDB() *profileDatabase {
	roles := map[string]familyRole{}
	for _, item := range []struct{ ID, Name string }{{"child", "Child"}, {"adult", "Adult"}, {"administrator", "Guardian"}} {
		rules := map[string]accessRule{}
		for action := range accessActions {
			rules[action] = accessRule{Mode: "allow"}
		}
		if item.ID != "administrator" {
			for _, action := range []string{"admin", "wipe", "restore", "storage"} {
				rules[action] = accessRule{Mode: "pin"}
			}
		}
		if item.ID == "child" {
			for _, action := range []string{"settings", "advanced", "libraryManager", "sources", "storage", "refresh", "logging", "logs", "health", "healthView", "export", "restore", "wipe", "setup", "covers", "titles", "metadata", "admin"} {
				rules[action] = accessRule{Mode: "disable", Hidden: true}
			}
		}
		if item.ID == "adult" {
			for _, action := range []string{"advanced", "libraryManager", "sources", "storage", "refresh", "logging", "health", "wipe", "restore", "setup", "covers", "metadata"} {
				rules[action] = accessRule{Mode: "pin"}
			}
		}
		roles[item.ID] = familyRole{ID: item.ID, Name: item.Name, Rules: rules}
		role := roles[item.ID]
		role.Template = item.ID
		role.Rules["wipe"] = accessRule{Mode: "guardian"}
		if item.ID == "adult" {
			for _, action := range []string{"admin", "advanced", "libraryManager", "sources", "storage", "refresh", "logging", "logs", "health", "healthView", "export", "restore", "setup", "covers", "titles", "metadata"} {
				role.Rules[action] = accessRule{Mode: "guardian"}
			}
		}
		roles[item.ID] = role
	}
	return &profileDatabase{Version: 1, SelectionVersion: 1, Epoch: 1, Groups: map[string]familyGroup{}, Roles: roles, Profiles: map[string]familyProfile{}}
}
func cloneProfileDB(value *profileDatabase) *profileDatabase {
	data, _ := json.Marshal(value)
	var copy profileDatabase
	json.Unmarshal(data, &copy)
	if copy.Groups == nil {
		copy.Groups = map[string]familyGroup{}
	}
	return &copy
}
func readProfileDBLocked() (*profileDatabase, error) {
	info, err := os.Stat(profilePath())
	if os.IsNotExist(err) {
		return defaultProfileDB(), nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxProfileData {
		return nil, errors.New("Family profile storage is unavailable")
	}
	if profileCache != nil && profileCacheHome == settingsHome && profileCacheSize == info.Size() && profileCacheStamp.Equal(info.ModTime()) {
		return profileCache, nil
	}
	data, err := os.ReadFile(profilePath())
	if err != nil {
		return nil, errors.New("Family profile storage is unavailable")
	}
	var value profileDatabase
	if json.Unmarshal(data, &value) != nil {
		return nil, errors.New("Family profile storage is unavailable")
	}
	if role, ok := value.Roles["administrator"]; ok && role.Name == "Administrator" {
		role.Name = "Guardian"
		value.Roles[role.ID] = role
	}
	migrateFamilyRoles(&value)
	if validateProfileDB(&value) != nil {
		return nil, errors.New("Family profile storage is unavailable")
	}
	profileCache = &value
	profileCacheHome = settingsHome
	profileCacheSize = info.Size()
	profileCacheStamp = info.ModTime()
	return &value, nil
}
func saveProfileDBLocked(value *profileDatabase, invalidate bool) error {
	if invalidate {
		value.Epoch++
	}
	if err := validateProfileDB(value); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > maxProfileData {
		return errors.New("Family profiles exceed available document capacity")
	}
	if err := savePrivateJSON(profilePath(), value); err != nil {
		return errors.New("Could not save family profiles")
	}
	profileCache = nil
	if invalidate {
		profileSessions = map[string]profileSession{}
		profileEdits = map[string]profileEditSession{}
	}
	return nil
}
func validProfileName(value string) bool {
	return utf8.ValidString(value) && len(strings.TrimSpace(value)) > 0 && utf8.RuneCountInString(value) <= 60 && !strings.ContainsAny(value, "\x00\r\n")
}
func validProfileID(value string) bool {
	return len(value) > 0 && len(value) <= 128 && !strings.ContainsAny(value, "\x00\r\n/\\")
}
func validateProfileDB(value *profileDatabase) error {
	if value == nil || value.Version != 1 || value.Roles == nil || value.Profiles == nil {
		return errors.New("Invalid family profile data")
	}
	for id, role := range value.Roles {
		if id != role.ID || !validProfileID(id) || !validProfileName(role.Name) {
			return errors.New("Choose a valid role name")
		}
		for action, rule := range role.Rules {
			if _, ok := accessActions[action]; !ok {
				return errors.New("Unknown role permission")
			}
			if rule.Mode != "allow" && rule.Mode != "pin" && rule.Mode != "guardian" && rule.Mode != "disable" {
				return errors.New("Invalid role permission")
			}
			if rule.Level != "" && rule.Level != "basic" && rule.Level != "advanced" {
				return errors.New("Invalid role category")
			}
		}
	}
	for id, group := range value.Groups {
		if id != group.ID || !validProfileID(id) || !validProfileName(group.Name) || len(group.Roles) == 0 {
			return errors.New("Choose a group name and at least one role")
		}
		for _, role := range group.Roles {
			if _, ok := value.Roles[role]; !ok {
				return errors.New("A group role is unavailable")
			}
		}
	}
	linked := map[string]string{}
	for id, profile := range value.Profiles {
		if id != profile.ID || !validProfileID(id) || !validProfileName(profile.Nickname) || len(profile.Roles)+len(profile.Groups) == 0 {
			return errors.New("Choose a nickname and at least one role")
		}
		for _, group := range profile.Groups {
			if _, ok := value.Groups[group]; !ok {
				return errors.New("A selected group is unavailable")
			}
		}
		if !profile.AllowMultipleRoles && len(profile.Roles)+len(profile.Groups) > 1 {
			return errors.New("Enable multiple Roles and Groups before selecting more than one")
		}
		for _, role := range profile.Roles {
			if _, ok := value.Roles[role]; !ok {
				return errors.New("A selected role is unavailable")
			}
		}
		if profile.UsesGuardianPIN {
			id := guardianID(profile.GuardianID)
			if id != "guardian-1" && id != "guardian-2" {
				return errors.New("Choose an available Guardian PIN")
			}
			if previous := linked[id]; previous != "" && previous != profile.ID {
				return errors.New("Each Guardian PIN can belong to only one profile")
			}
			linked[id] = profile.ID
			if !profileRequiresPIN(profile) || !containsProfileID(profile.Roles, "administrator") || profile.Hash != "" || profile.Salt != "" {
				return errors.New("Guardian-linked profiles must use the Guardian role and shared PIN")
			}
		} else if !profileRequiresPIN(profile) {
			if profileHasAdministrativeActions(value, profile) && !profile.UnprotectedAdmin {
				return fmt.Errorf("Set a PIN for %s before granting administrative permissions", profile.Nickname)
			}
			if profile.Salt != "" || profile.Hash != "" {
				return errors.New("Unprotected profiles must not retain a PIN verifier")
			}
		} else {
			salt, e1 := base64.StdEncoding.DecodeString(profile.Salt)
			hash, e2 := base64.StdEncoding.DecodeString(profile.Hash)
			if e1 != nil || e2 != nil || len(salt) != 16 || len(hash) != 32 {
				return errors.New("Invalid profile PIN verifier")
			}
		}
		if err := validateProfileAvatar(profile.Avatar); err != nil {
			return err
		}
		if err := validatePreferences(profile.Preferences); err != nil {
			return err
		}
		for _, entry := range append(append([]string{}, profile.Libraries...), profile.Games...) {
			if len(entry) > 512 || strings.ContainsAny(entry, "\x00\r\n") {
				return errors.New("Invalid library or game selection")
			}
		}
	}
	return nil
}
func profileCookie(r *http.Request) string {
	cookie, err := r.Cookie("gameshelf-profile")
	if err != nil || len(cookie.Value) != 64 {
		return ""
	}
	return cookie.Value
}
func profileView(r *http.Request) *profileContext {
	value, _ := r.Context().Value(profileContextKey{}).(*profileContext)
	return value
}
func roleRank(mode string) int {
	switch mode {
	case "disable":
		return 4
	case "guardian":
		return 3
	case "pin":
		return 2
	default:
		return 1
	}
}
func mergedProfileRules(db *profileDatabase, p familyProfile) map[string]accessRule {
	result := map[string]accessRule{}
	for action := range accessActions {
		first := true
		var picked accessRule
		for _, id := range effectiveProfileRoles(db, p) {
			candidate := db.Roles[id].Rules[action]
			if candidate.Mode == "" {
				candidate.Mode = "allow"
			}
			if first || roleRank(candidate.Mode) < roleRank(picked.Mode) {
				picked = candidate
				first = false
			} else if roleRank(candidate.Mode) == roleRank(picked.Mode) {
				picked.Hidden = picked.Hidden && candidate.Hidden
			}
		}
		result[action] = picked
	}
	if p.UsesGuardianPIN {
		for action := range result {
			result[action] = accessRule{Mode: "allow"}
		}
	}
	result["wipe"] = accessRule{Mode: "guardian"}
	return result
}

func effectiveProfileRoles(db *profileDatabase, p familyProfile) []string {
	list := append([]string{}, p.Roles...)
	for _, id := range p.Groups {
		for _, role := range db.Groups[id].Roles {
			if !containsProfileID(list, role) {
				list = append(list, role)
			}
		}
	}
	return list
}

func profileMode(r *http.Request, action string) string {
	if value := profileView(r); value != nil {
		return value.Rules[action].Mode
	}
	return "allow"
}
func localLibraryID(root string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(root)))
	return fmt.Sprintf("folder-%x", sum[:16])
}
func profileLibraryID(entry *gameEntry) string {
	if entry.NetworkID != "" {
		return entry.NetworkID
	}
	return localLibraryID(entryRootDir(entry))
}
func containsProfileID(values []string, id string) bool {
	for _, value := range values {
		if value == id {
			return true
		}
	}
	return false
}
func profileAllows(r *http.Request, entry *gameEntry) bool {
	view := profileView(r)
	if view == nil {
		return true
	}
	p := view.Profile
	return (p.AllLibraries || containsProfileID(p.Libraries, profileLibraryID(entry))) && (p.AllGames || containsProfileID(p.Games, entry.Game.ID))
}
func profileGame(r *http.Request, entry *gameEntry) Game {
	value := entry.Game
	if view := profileView(r); view != nil {
		value.Favorite = view.Profile.Favorites[value.ID]
	}
	return value
}
func combinedAccessPolicy(r *http.Request, policy *accessPolicy) *accessPolicy {
	view := profileView(r)
	if view == nil {
		return policy
	}
	result := &accessPolicy{Rules: map[string]accessRule{}}
	if policy != nil {
		result.Remember = policy.Remember
		for action, rule := range policy.Rules {
			result.Rules[action] = rule
		}
	}
	for action, role := range view.Rules {
		rule := result.Rules[action]
		if roleRank(role.Mode) > roleRank(rule.Mode) {
			rule.Mode = role.Mode
		}
		rule.Hidden = rule.Hidden || role.Hidden
		if role.Level != "" {
			rule.Level = role.Level
		}
		result.Rules[action] = rule
	}
	if !view.Profile.AllLibraries || !view.Profile.AllGames {
		for _, action := range []string{"libraryManager", "sources", "storage", "refresh", "logging", "logs", "health", "healthView", "export", "restore", "wipe", "setup"} {
			rule := result.Rules[action]
			if rule.Mode != "disable" {
				rule.Mode = "guardian"
			}
			result.Rules[action] = rule
		}
	}
	return result
}
func guardianMenu(r *http.Request) bool { return hasPINGrant(r, "admin") }
func profileGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/download") && !strings.HasPrefix(path, "/covers/") {
			next.ServeHTTP(w, r)
			return
		}
		isProfiles := strings.HasPrefix(path, "/api/profiles")
		isAccess := strings.HasPrefix(path, "/api/access")
		profileMu.Lock()
		db, err := readProfileDBLocked()
		if err != nil {
			profileMu.Unlock()
			http.Error(w, "Family profiles unavailable. Ask a Guardian to check saved data.", 503)
			return
		}
		enabled := db.Enabled && !setupRequired.Load()
		session, ok := profileSessions[profileCookie(r)]
		if ok && (session.Home != settingsHome || session.Epoch != db.Epoch || time.Now().After(session.Until)) {
			ok = false
		}
		var view *profileContext
		if ok {
			if profile, exists := sessionProfile(db, session); exists {
				view = &profileContext{profile, mergedProfileRules(db, profile), db.Epoch}
			}
		}
		profileMu.Unlock()
		if enabled && view == nil && !isAccess && !isProfiles && !guardianMenu(r) {
			writeAccessError(w, 401, "profile_required", nil, "Choose your family profile.")
			return
		}
		if enabled {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Add("Vary", "Cookie")
		}
		if enabled && view != nil {
			r = r.WithContext(context.WithValue(r.Context(), profileContextKey{}, view))
		}
		for _, prefix := range []string{"/covers/", "/download/", "/api/game-files/", "/api/game-file/", "/api/covers/", "/api/cover-source/", "/api/cover-fit/", "/api/game-title/", "/api/favorite/", "/api/metadata-reset/"} {
			if strings.HasPrefix(path, prefix) {
				entry := getGameEntryByID(strings.TrimPrefix(path, prefix))
				if entry == nil || !profileAllows(r, entry) {
					http.NotFound(w, r)
					return
				}
				break
			}
		}
		if path == "/download-cart" || path == "/download-playlist" {
			for _, id := range r.URL.Query()["game"] {
				entry := getGameEntryByID(id)
				if entry == nil || !profileAllows(r, entry) {
					http.NotFound(w, r)
					return
				}
			}
		}
		if view != nil && (!view.Profile.AllLibraries || !view.Profile.AllGames) && !hasPINGrant(r, "libraryManager") {
			if path == "/api/source-status" {
				profileReply(w, map[string]any{"busy": false, "sources": []any{}})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func publicProfile(p familyProfile, databases ...*profileDatabase) familyProfile {
	if len(databases) > 0 {
		p.EffectiveRoles = effectiveProfileRoles(databases[0], p)
	}
	p.HasSavedPIN = p.Hash != "" || p.UsesGuardianPIN
	p.Salt = ""
	p.Hash = ""
	return p
}
func currentProfileLocked(r *http.Request, db *profileDatabase) (familyProfile, bool) {
	session, ok := profileSessions[profileCookie(r)]
	if !ok || session.Home != settingsHome || session.Epoch != db.Epoch || time.Now().After(session.Until) {
		return familyProfile{}, false
	}
	return sessionProfile(db, session)
}
func profileReply(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(value)
}
func decodeProfileBody(w http.ResponseWriter, r *http.Request, value any) bool {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxProfileData+1))
	if err != nil || len(data) > maxProfileData || !json.Valid(data) {
		http.Error(w, "Send one valid profile document.", 400)
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		http.Error(w, "Invalid profile options.", 400)
		return false
	}
	return true
}
func profileLibraries() []map[string]string {
	settingsMu.RLock()
	settings := configuredSettings
	settingsMu.RUnlock()
	list := []map[string]string{}
	for _, root := range libraryRoots(settings) {
		list = append(list, map[string]string{"id": localLibraryID(root), "name": filepath.Base(root), "location": root})
	}
	for _, source := range settings.Sources {
		list = append(list, map[string]string{"id": source.ID, "name": source.Name, "location": source.URL})
	}
	return list
}
func handleProfiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	manage := r.URL.Query().Get("manage") == "1" || r.Method != "GET"
	if r.Method != "GET" {
		accessConfigMu.Lock()
		defer accessConfigMu.Unlock()
	}
	if manage && !checkAccess(w, r, []string{"admin"}) {
		return
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	if err != nil {
		http.Error(w, err.Error(), 503)
		return
	}
	if r.Method == "GET" {
		if manage {
			profiles := []familyProfile{}
			for _, p := range db.Profiles {
				profiles = append(profiles, publicProfile(p, db))
			}
			sort.Slice(profiles, func(i, j int) bool {
				return strings.ToLower(profiles[i].Nickname) < strings.ToLower(profiles[j].Nickname)
			})
			groups := map[string]string{}
			for action := range accessActions {
				groups[action] = accessGroup(action)
			}
			profileReply(w, map[string]any{"enabled": db.Enabled, "profiles": profiles, "roles": db.Roles, "profileGroups": db.Groups, "roleDefaults": defaultProfileDB().Roles, "libraries": profileLibraries(), "actions": accessActions, "groups": groups, "pinProtectedActions": profileAdministrativeActions, "guardians": publicGuardians(), "guardianConfigured": guardianAvailable()})
			return
		}
		roleNames := map[string]string{}
		for id, role := range db.Roles {
			roleNames[id] = role.Name
		}
		profiles := []map[string]any{}
		for _, p := range db.Profiles {
			if p.Hidden {
				continue
			}
			profiles = append(profiles, map[string]any{"id": p.ID, "nickname": p.Nickname, "avatar": p.Avatar, "pinRequired": profileRequiresPIN(p), "roles": effectiveProfileRoles(db, p), "groups": p.Groups, "usesGuardianPIN": p.UsesGuardianPIN, "guardianID": p.GuardianID})
		}
		if guardianProfilePicker(db) {
			p := standaloneGuardian()
			profiles = append(profiles, map[string]any{"id": p.ID, "nickname": p.Nickname, "avatar": p.Avatar, "pinRequired": true, "roles": p.Roles, "standaloneGuardian": true})
		}
		sort.Slice(profiles, func(i, j int) bool { return profiles[i]["nickname"].(string) < profiles[j]["nickname"].(string) })
		p, active := currentProfileLocked(r, db)
		var current any
		if active {
			current = publicProfile(p, db)
		}
		profileReply(w, map[string]any{"enabled": db.Enabled, "needsProfile": db.Enabled && !setupRequired.Load() && !active, "profiles": profiles, "roleNames": roleNames, "active": current, "hasProfileData": func() bool { _, err := os.Stat(profilePath()); return err == nil }()})
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var body struct {
		Operation        string
		Profile          familyProfile
		Role             familyRole
		Group            familyGroup
		Members          []string
		PIN              string
		ConfirmPIN       string
		ClearAvatar      bool
		AcknowledgeAdmin bool
		Enabled          *bool
	}
	if !decodeProfileBody(w, r, &body) {
		return
	}
	copy := cloneProfileDB(db)
	switch body.Operation {
	case "configure":
		if body.Enabled == nil {
			http.Error(w, "Choose whether profiles are enabled.", 400)
			return
		}
		if *body.Enabled {
			record, err := readPINRecord()
			if err != nil || record == nil {
				writeAccessError(w, 428, "pin_setup_required", nil, "Create a Guardian PIN before enabling profiles.")
				return
			}

		}
		if copy.Enabled && !*body.Enabled && !checkFreshPIN(w, r, []string{"admin"}) {
			return
		}
		copy.Enabled = *body.Enabled
	case "profile":
		p := body.Profile
		old, exists := copy.Profiles[p.ID]
		if !exists {
			key, err := randomKey()
			if err != nil {
				http.Error(w, "Could not create profile.", 503)
				return
			}
			p.ID = "p-" + key[:24]
		}
		if exists && p.PINRequired == nil {
			p.PINRequired = old.PINRequired
		}
		if exists && p.Avatar == "" && !body.ClearAvatar {
			p.Avatar = old.Avatar
		}
		p.Salt = old.Salt
		p.Hash = old.Hash
		p.EffectiveRoles = nil
		p.HasSavedPIN = false
		if p.Preferences == nil {
			p.Preferences = old.Preferences
		} else {
			merged := map[string]string{}
			for key, value := range old.Preferences {
				merged[key] = value
			}
			for key, value := range p.Preferences {
				merged[key] = value
			}
			p.Preferences = merged
		}
		p.Favorites = old.Favorites
		p.Nickname = strings.TrimSpace(p.Nickname)
		avatar, avatarErr := normalizeProfileAvatar(p.Avatar)
		if avatarErr != nil {
			http.Error(w, avatarErr.Error(), 400)
			return
		}
		p.Avatar = avatar
		if p.UsesGuardianPIN {
			record, _ := readPINRecord()
			if _, exists := guardianCredentialByID(record, p.GuardianID); !exists {
				writeAccessError(w, 428, "pin_setup_required", []string{"admin"}, "Create a Guardian PIN before linking a profile.")
				return
			}
			p.GuardianID = guardianID(p.GuardianID)
			p.Salt = ""
			p.Hash = ""
			required := true
			p.PINRequired = &required
			p.Roles = []string{"administrator"}
			p.Groups = nil
			p.AllLibraries = true
			p.AllGames = true
			p.Libraries = nil
			p.Games = nil
			p.ForcePINChange = false
			p.UnprotectedAdmin = false
		} else if !profileRequiresPIN(p) {
			if profileHasAdministrativeActions(copy, p) && (!p.UnprotectedAdmin || !body.AcknowledgeAdmin) {
				http.Error(w, "Acknowledge administrative access without a profile PIN before saving.", 400)
				return
			}
			p.Salt = ""
			p.Hash = ""
		} else if !exists || old.Hash == "" || body.PIN != "" {
			if !validPIN(body.PIN) || body.PIN != body.ConfirmPIN {
				http.Error(w, "Enter the same 4-digit PIN twice.", 400)
				return
			}
			key, err := randomKey()
			if err != nil {
				http.Error(w, "Could not create profile PIN.", 503)
				return
			}
			salt, _ := hex.DecodeString(key[:32])
			hash, err := pbkdf2.Key(sha256.New, body.PIN, salt, pinIterations, 32)
			if err != nil {
				http.Error(w, "Could not create profile PIN.", 503)
				return
			}
			p.Salt = base64.StdEncoding.EncodeToString(salt)
			p.Hash = base64.StdEncoding.EncodeToString(hash)
		}
		if !profileRequiresPIN(p) {
			p.ForcePINChange = false
		} else {
			p.UnprotectedAdmin = false
		}
		if !p.UsesGuardianPIN {
			p.GuardianID = ""
		}
		if old.UsesGuardianPIN && !p.UsesGuardianPIN && p.Avatar == "builtin:ember-knight" {
			p.Avatar = "builtin:moonlit-knight"
		}
		if p.Avatar == "builtin:ember-knight" && !containsProfileID(effectiveProfileRoles(db, p), "administrator") {
			http.Error(w, "The GameShelf Guardian portrait belongs to the Guardian role.", 400)
			return
		}
		copy.Profiles[p.ID] = p
	case "deleteProfile":
		if _, ok := copy.Profiles[body.Profile.ID]; !ok {
			http.NotFound(w, r)
			return
		}
		delete(copy.Profiles, body.Profile.ID)
		if len(copy.Profiles) == 0 {
			copy.Enabled = false
		}
	case "role":
		role := body.Role
		role.Name = strings.TrimSpace(role.Name)
		if role.ID == "" {
			key, err := randomKey()
			if err != nil {
				http.Error(w, "Could not create role.", 503)
				return
			}
			role.ID = "r-" + key[:24]
		}
		if old, ok := copy.Roles[role.ID]; ok {
			role.Template = old.Template
		}
		if role.Template == "" {
			role.Template = "adult"
		}
		if role.Rules == nil {
			role.Rules = map[string]accessRule{}
		}
		role.Rules["wipe"] = accessRule{Mode: "guardian"}
		copy.Roles[role.ID] = role
	case "resetRole":
		old, ok := copy.Roles[body.Role.ID]
		if !ok {
			http.NotFound(w, r)
			return
		}
		template := old.Template
		if template == "" {
			template = old.ID
		}
		defaults, ok := defaultProfileDB().Roles[template]
		if !ok {
			http.Error(w, "Choose a built-in role template.", 400)
			return
		}
		defaults.ID = old.ID
		if !containsProfileID([]string{"administrator", "adult", "child"}, old.ID) {
			defaults.Name = old.Name
		}
		copy.Roles[old.ID] = defaults
	case "group":
		group := body.Group
		group.Name = strings.TrimSpace(group.Name)
		if group.ID == "" {
			key, err := randomKey()
			if err != nil {
				http.Error(w, "Could not create group.", 503)
				return
			}
			group.ID = "g-" + key[:24]
		}
		copy.Groups[group.ID] = group
		for _, id := range body.Members {
			if _, ok := copy.Profiles[id]; !ok {
				http.Error(w, "A selected profile is unavailable.", 400)
				return
			}
		}
		for id, p := range copy.Profiles {
			old := p
			out := []string{}
			for _, g := range p.Groups {
				if g != group.ID {
					out = append(out, g)
				}
			}
			if containsProfileID(body.Members, id) {
				if p.UsesGuardianPIN {
					http.Error(w, "Guardian-linked profiles keep their full administrative role.", 400)
					return
				}
				out = append(out, group.ID)
				if !p.AllowMultipleRoles {
					p.Roles = nil
					out = []string{group.ID}
				}
			}
			p.Groups = out
			if len(p.Groups)+len(p.Roles) == 0 {
				p.Roles = []string{"child"}
			}
			if profileHasAdministrativeActions(copy, p) && (!profileHasAdministrativeActions(db, old) || !profileRequiresPIN(p) && !p.UnprotectedAdmin) {
				if !body.AcknowledgeAdmin {
					http.Error(w, "Acknowledge the group's administrative permissions before saving.", 400)
					return
				}
				if !profileRequiresPIN(p) {
					p.UnprotectedAdmin = true
				}
			}
			copy.Profiles[id] = p
		}
	case "deleteGroup":
		if _, ok := copy.Groups[body.Group.ID]; !ok {
			http.NotFound(w, r)
			return
		}
		for _, p := range copy.Profiles {
			if containsProfileID(p.Groups, body.Group.ID) {
				http.Error(w, "Move profiles out of this group before removing it.", 409)
				return
			}
		}
		delete(copy.Groups, body.Group.ID)
	case "deleteRole":
		if body.Role.ID == "child" || body.Role.ID == "adult" || body.Role.ID == "elevated" || body.Role.ID == "administrator" {
			http.Error(w, "Starter roles can be edited, but not removed.", 409)
			return
		}
		for _, p := range copy.Profiles {
			if containsProfileID(p.Roles, body.Role.ID) {
				http.Error(w, "Move profiles to another role before removing it.", 409)
				return
			}
		}
		for _, g := range copy.Groups {
			if containsProfileID(g.Roles, body.Role.ID) {
				http.Error(w, "Remove this role from its groups first.", 409)
				return
			}
		}
		delete(copy.Roles, body.Role.ID)
	default:
		http.Error(w, "Unknown profile change.", 400)
		return
	}
	if err := saveProfileDBLocked(copy, true); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	auditProfile(r, "Family profile configuration changed ("+body.Operation+")")
	profileReply(w, map[string]any{"saved": true})
}
func allowProfileAttempt(r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	now := time.Now()
	for key, budget := range profileAttempts {
		if now.Sub(budget.Window) >= time.Minute {
			delete(profileAttempts, key)
		}
	}
	for _, key := range []string{"global", "ip:" + ip} {
		budget := profileAttempts[key]
		limit := 10
		if key == "global" {
			limit = 120
		}
		if budget.Attempts >= limit || len(profileAttempts) >= 4096 {
			return false
		}
	}
	for _, key := range []string{"global", "ip:" + ip} {
		budget := profileAttempts[key]
		if budget.Window.IsZero() {
			budget.Window = now
		}
		budget.Attempts++
		profileAttempts[key] = budget
	}
	return true
}
func handleProfileLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var value struct{ ID, PIN string }
	if !decodeProfileBody(w, r, &value) {
		return
	}

	accessConfigMu.Lock()
	defer accessConfigMu.Unlock()
	profileMu.Lock()
	defer profileMu.Unlock()
	if !allowProfileAttempt(r) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "Too many attempts. Wait one minute.", 429)
		return
	}
	db, err := readProfileDBLocked()
	if err != nil {
		http.Error(w, "Family profiles unavailable.", 503)
		return
	}
	p, ok := db.Profiles[value.ID]
	if value.ID == "guardian" && db.Enabled && guardianAvailable() {
		p = standaloneGuardian()
		ok = true
	}
	if !ok {
		http.Error(w, "Profile or PIN did not match.", 401)
		return
	}
	if profileRequiresPIN(p) {
		if !validPIN(value.PIN) {
			http.Error(w, "Enter a 4-digit PIN.", 400)
			return
		}
		salt, expected, iterations, verifierErr := profilePINVerifier(p)
		if verifierErr != nil {
			http.Error(w, "Guardian PIN is unavailable. Ask the server owner to configure it.", 503)
			return
		}
		actual, err := pbkdf2.Key(sha256.New, value.PIN, salt, iterations, 32)
		if err != nil || subtle.ConstantTimeCompare(actual, expected) != 1 {
			logEvent("errors", "Family profile PIN rejected")
			http.Error(w, "Profile or PIN did not match.", 401)
			return
		}
	}
	if p.ForcePINChange {
		if err := issueProfileEdit(w, r, p.ID, true, db.Epoch); err != nil {
			http.Error(w, err.Error(), 503)
			return
		}
		profileReply(w, map[string]any{"changeRequired": true, "id": p.ID})
		return
	}
	now := time.Now()
	for token, session := range profileSessions {
		if session.Home != settingsHome || now.After(session.Until) {
			delete(profileSessions, token)
		}
	}
	if len(profileSessions) >= 4096 {
		http.Error(w, "Too many active profile sessions.", 503)
		return
	}
	token, err := randomKey()
	if err != nil {
		http.Error(w, "Could not open profile.", 503)
		return
	}
	if old := profileCookie(r); old != "" {
		delete(profileSessions, old)
	}
	showTour := p.TourPending
	if showTour && p.ID != "guardian" {
		copy := cloneProfileDB(db)
		updated := copy.Profiles[p.ID]
		updated.TourPending = false
		copy.Profiles[p.ID] = updated
		if err := saveProfileDBLocked(copy, false); err != nil {
			http.Error(w, "Could not prepare profile tour.", 503)
			return
		}
	}
	profileSessions[token] = profileSession{Home: settingsHome, Profile: p.ID, Epoch: db.Epoch, Until: now.Add(8 * time.Hour), Guardian: p.ID == "guardian"}
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-profile", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	// Switching identities must never carry a Guardian unlock into the next profile.
	accessMu.Lock()
	delete(accessSessions, pinCookie(r))
	accessMu.Unlock()
	profileReply(w, map[string]any{"profile": publicProfile(p, db), "showTour": showTour})
	logEvent("profile", "%s signed in", p.Nickname)
}
func handleProfileLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	profileMu.Lock()
	if c, e := r.Cookie("gameshelf-profile-edit"); e == nil {
		delete(profileEdits, c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-profile-edit", Value: "", Path: "/api/profiles", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	delete(profileSessions, profileCookie(r))
	profileMu.Unlock()
	accessMu.Lock()
	delete(accessSessions, pinCookie(r))
	accessMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-profile", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	w.WriteHeader(204)
}
func handleProfileCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	if !checkAccess(w, r, []string{"admin"}) {
		return
	}
	gamesMu.RLock()
	defer gamesMu.RUnlock()
	list := []map[string]string{}
	for _, entry := range gamesMap {
		list = append(list, map[string]string{"id": entry.Game.ID, "name": entry.Game.Name, "library": profileLibraryID(entry)})
	}
	sort.Slice(list, func(i, j int) bool { return list[i]["name"] < list[j]["name"] })
	profileReply(w, list)
}
func saveProfilePreferences(r *http.Request, values map[string]string) error {
	view := profileView(r)
	if view == nil || view.Profile.ID == "guardian" {
		return nil
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	if err != nil {
		return err
	}
	if db.Epoch != view.Epoch {
		return errors.New("Profile permissions changed. Choose your profile again.")
	}
	copy := cloneProfileDB(db)
	p := copy.Profiles[view.Profile.ID]
	if p.Preferences == nil {
		p.Preferences = map[string]string{}
	}
	for key, value := range values {
		p.Preferences[key] = value
	}
	copy.Profiles[p.ID] = p
	return saveProfileDBLocked(copy, false)
}
func saveProfileFavorite(w http.ResponseWriter, r *http.Request, id string, favorite bool) bool {
	view := profileView(r)
	if view == nil || view.Profile.ID == "guardian" {
		return false
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	if err != nil || db.Epoch != view.Epoch {
		http.Error(w, "Profile changed. Choose it again.", 409)
		return true
	}
	copy := cloneProfileDB(db)
	p := copy.Profiles[view.Profile.ID]
	if p.Favorites == nil {
		p.Favorites = map[string]bool{}
	}
	if favorite {
		p.Favorites[id] = true
	} else {
		delete(p.Favorites, id)
	}
	copy.Profiles[p.ID] = p
	if saveProfileDBLocked(copy, false) != nil {
		http.Error(w, "Could not save favorite.", 503)
		return true
	}
	profileReply(w, map[string]bool{"favorite": favorite})
	return true
}

func profileSafeSettings(r *http.Request, value serverSettings) serverSettings {
	view := profileView(r)
	configurationApproved := false
	for _, action := range []string{"libraryManager", "sources", "storage", "refresh", "logging", "health"} {
		configurationApproved = configurationApproved || hasPINGrant(r, action)
	}
	if view == nil || view.Profile.AllLibraries && view.Profile.AllGames || configurationApproved || guardianMenu(r) {
		return value
	}
	value.RootDir = ""
	value.RootDirs = nil
	value.Sources = nil
	value.DataDir = ""
	value.Preferences = view.Profile.Preferences
	return value
}

func profileVisibleMounts(r *http.Request) []string {
	if view := profileView(r); view != nil && (!view.Profile.AllLibraries || !view.Profile.AllGames) && !hasPINGrant(r, "libraryManager") && !guardianMenu(r) {
		return []string{}
	}
	return readableLibraryMounts()
}

func migrateFamilyRoles(db *profileDatabase) {
	if db.Groups == nil {
		db.Groups = map[string]familyGroup{}
	}
	if db.SelectionVersion == 0 {
		for id, p := range db.Profiles {
			p.AllowMultipleRoles = len(p.Roles)+len(p.Groups) > 1
			db.Profiles[id] = p
		}
		db.SelectionVersion = 1
	}
	for id, role := range db.Roles {
		if role.Rules == nil {
			role.Rules = map[string]accessRule{}
		}
		role.Rules["wipe"] = accessRule{Mode: "guardian"}
		if role.Template == "" && containsProfileID([]string{"administrator", "adult", "child"}, id) {
			role.Template = id
		}
		db.Roles[id] = role
	}
	if _, ok := db.Roles["elevated"]; ok {
		delete(db.Roles, "elevated")
		for id, p := range db.Profiles {
			out := []string{}
			for _, role := range p.Roles {
				if role == "elevated" {
					role = "adult"
				}
				if !containsProfileID(out, role) {
					out = append(out, role)
				}
			}
			p.Roles = out
			db.Profiles[id] = p
		}
	}
	for id, p := range db.Profiles {
		if p.UsesGuardianPIN {
			p.GuardianID = guardianID(p.GuardianID)
		}
		if p.Avatar == "builtin:ember-knight" && !containsProfileID(effectiveProfileRoles(db, p), "administrator") {
			p.Avatar = "builtin:moonlit-knight"
		}
		db.Profiles[id] = p
	}
}
