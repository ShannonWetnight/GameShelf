package main

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type profileEditSession struct {
	Home, Profile string
	Epoch         uint64
	Until         time.Time
	ChangeOnly    bool
}

var profileEdits = map[string]profileEditSession{}

// Profile edits never inherit Guardian privileges and cannot change assignments,
// roles, visibility, or any shared setting. A separate short-lived cookie keeps
// editing another profile from switching the active shelf.
func issueProfileEdit(w http.ResponseWriter, r *http.Request, id string, changeOnly bool, epoch uint64) error {
	key, err := randomKey()
	if err != nil {
		return err
	}
	for k, s := range profileEdits {
		if s.Home != settingsHome || time.Now().After(s.Until) {
			delete(profileEdits, k)
		}
	}
	if len(profileEdits) >= 1024 {
		return errors.New("Too many profile editors. Try again later.")
	}
	profileEdits[key] = profileEditSession{settingsHome, id, epoch, time.Now().Add(5 * time.Minute), changeOnly}
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-profile-edit", Value: key, Path: "/api/profiles", MaxAge: 300, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	return nil
}
func profilePINMatches(p familyProfile, pin string) bool {
	if !profileRequiresPIN(p) {
		return pin == ""
	}
	if !validPIN(pin) {
		return false
	}
	salt, expected, iterations, err := profilePINVerifier(p)
	if err != nil {
		return false
	}
	actual, err := pbkdf2.Key(sha256.New, pin, salt, iterations, 32)
	return err == nil && subtle.ConstantTimeCompare(actual, expected) == 1
}
func setProfilePIN(p *familyProfile, pin string) error {
	if !validPIN(pin) {
		return errors.New("Choose a 4-digit PIN")
	}
	c, err := makeGuardianCredential("", pin)
	if err != nil {
		return err
	}
	p.Salt, p.Hash = c.Salt, c.Hash
	required := true
	p.PINRequired = &required
	return nil
}

func handleProfileSelf(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	accessConfigMu.Lock()
	defer accessConfigMu.Unlock()
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	if err != nil {
		http.Error(w, "Profile data is unavailable.", 503)
		return
	}
	if r.URL.Path == "/api/profiles/self/open" {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", 405)
			return
		}
		if !allowProfileAttempt(r) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "Too many attempts. Try again in a minute.", 429)
			return
		}
		var value struct{ ID, PIN string }
		if !decodeProfileBody(w, r, &value) {
			return
		}
		p, ok := db.Profiles[value.ID]
		if !ok || !profilePINMatches(p, value.PIN) {
			logEvent("profile", "Profile edit authentication rejected")
			http.Error(w, "Profile or PIN did not match.", 401)
			return
		}
		if issueProfileEdit(w, r, p.ID, false, db.Epoch) != nil {
			http.Error(w, "Could not open profile editor.", 503)
			return
		}
		profileReply(w, map[string]any{"profile": publicProfile(p, db)})
		logEvent("profile", "%s opened personal profile information", p.Nickname)
		return
	}
	cookie, err := r.Cookie("gameshelf-profile-edit")
	if err != nil {
		http.Error(w, "Open this profile's editor again.", 401)
		return
	}
	session, ok := profileEdits[cookie.Value]
	p, exists := db.Profiles[session.Profile]
	if !ok || !exists || session.Home != settingsHome || session.Epoch != db.Epoch || time.Now().After(session.Until) {
		http.Error(w, "Profile approval expired. Open the editor again.", 401)
		return
	}
	if r.Method == "GET" {
		profileReply(w, map[string]any{"profile": publicProfile(p, db), "changeOnly": session.ChangeOnly})
		return
	}
	if r.Method != "PUT" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var value struct {
		Nickname, Avatar, NewPIN, ConfirmPIN string
		ClearAvatar                          bool
	}
	if !decodeProfileBody(w, r, &value) {
		return
	}
	if session.ChangeOnly && value.NewPIN == "" {
		http.Error(w, "Choose a new PIN before continuing.", 400)
		return
	}
	oldRecord, _ := readPINRecord()
	record := oldRecord
	if value.NewPIN != "" {
		if value.NewPIN != value.ConfirmPIN || !validPIN(value.NewPIN) {
			http.Error(w, "Enter the same 4-digit PIN twice.", 400)
			return
		}
		if profilePINMatches(p, value.NewPIN) {
			http.Error(w, "Choose a different PIN.", 400)
			return
		}
		if p.UsesGuardianPIN {
			if oldRecord == nil {
				http.Error(w, "Guardian PIN is unavailable.", 503)
				return
			}
			copy := *oldRecord
			record = &copy
			if err := setGuardianCredential(record, p.GuardianID, value.NewPIN); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
		} else if err := setProfilePIN(&p, value.NewPIN); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		p.ForcePINChange = false
	}
	if !session.ChangeOnly {
		p.Nickname = strings.TrimSpace(value.Nickname)
		if !validProfileName(p.Nickname) {
			http.Error(w, "Choose a nickname.", 400)
			return
		}
		if value.Avatar != "" || value.ClearAvatar {
			avatar, err := normalizeProfileAvatar(value.Avatar)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			if avatar == "builtin:ember-knight" && !containsProfileID(effectiveProfileRoles(db, p), "administrator") {
				http.Error(w, "Choose a portrait for this role.", 400)
				return
			}
			p.Avatar = avatar
		}
	}
	copy := cloneProfileDB(db)
	copy.Profiles[p.ID] = p
	if record != oldRecord {
		if err := savePrivateJSON(pinPath(), record); err != nil {
			http.Error(w, "Could not save Guardian PIN.", 503)
			return
		}
	}
	if err := saveProfileDBLocked(copy, false); err != nil {
		if record != oldRecord {
			savePrivateJSON(pinPath(), oldRecord)
		}
		http.Error(w, err.Error(), 400)
		return
	}
	for token, s := range profileSessions {
		if value.NewPIN != "" && (s.Profile == p.ID || record != oldRecord && s.Guardian) {
			delete(profileSessions, token)
		}
	}
	for token, edit := range profileEdits {
		if edit.Profile == p.ID || record != oldRecord {
			delete(profileEdits, token)
		}
	}
	if record != oldRecord {
		accessMu.Lock()
		accessSessions = map[string]*pinSession{}
		accessMu.Unlock()
	}
	logEvent("profile", "%s updated personal profile information%s", p.Nickname, func() string {
		if value.NewPIN != "" {
			return " and reset its PIN"
		}
		return ""
	}())
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"saved": true, "profile": publicProfile(p, db), "changeOnly": session.ChangeOnly})
}
