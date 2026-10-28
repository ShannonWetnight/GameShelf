package main

import (
	"net/http"
	"os"
)

// accessConfigMu and setupMu serialize credential removal with PIN changes,
// profile edits, and settings replacement. IDs stay stable for the other Guardian.
func removeGuardianCredential(w http.ResponseWriter, r *http.Request, record *pinRecord, settings serverSettings) {
	id := r.URL.Query().Get("guardianID")
	if _, ok := guardianCredentialByID(record, id); !ok {
		http.Error(w, "Choose an existing Guardian PIN.", 400)
		return
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	if err != nil {
		http.Error(w, "Profile data is unavailable.", 503)
		return
	}
	roleID := r.URL.Query().Get("role")
	if roleID == "" {
		roleID = "adult"
	}
	if _, ok := db.Roles[roleID]; !ok || roleID == "administrator" {
		http.Error(w, "Choose a replacement role other than Guardian.", 400)
		return
	}
	last := len(guardianCredentials(record)) == 1
	if last && r.URL.Query().Get("disableProfiles") != "1" {
		http.Error(w, "Removing the last Guardian PIN turns off Family Profiles. Confirm this choice or create another Guardian PIN first.", 409)
		return
	}
	next := *record
	if id == "guardian-1" {
		next.PrimaryDisabled = true
		next.Salt = ""
		next.Hash = ""
	} else {
		next.Secondary = nil
	}
	copy := cloneProfileDB(db)
	if last {
		copy.Enabled = false
	}
	for key, p := range copy.Profiles {
		if p.UsesGuardianPIN && guardianID(p.GuardianID) == id {
			p.UsesGuardianPIN = false
			p.GuardianID = ""
			p.Roles = []string{roleID}
			p.Groups = nil
			p.AllowMultipleRoles = false
			p.Salt = ""
			p.Hash = ""
			required := false
			p.PINRequired = &required
			p.ForcePINChange = false
			p.UnprotectedAdmin = profileHasAdministrativeActions(copy, p)
			if p.Avatar == "builtin:ember-knight" {
				p.Avatar = "builtin:moonlit-knight"
			}
			copy.Profiles[key] = p
		}
	}
	if err := validateProfileDB(copy); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if !last {
		if err := savePrivateJSON(pinPath(), &next); err != nil {
			http.Error(w, "Could not remove Guardian PIN.", 503)
			return
		}
	}
	if err := saveProfileDBLocked(copy, true); err != nil {
		if !last {
			savePrivateJSON(pinPath(), record)
		}
		http.Error(w, err.Error(), 503)
		return
	}
	if last {
		previous := settings
		settings.Access = nil
		if err := saveServerSettings(settings); err != nil {
			saveProfileDBLocked(db, true)
			http.Error(w, "Could not turn off Family Profiles.", 503)
			return
		}
		if err := os.Remove(pinPath()); err != nil {
			saveServerSettings(previous)
			saveProfileDBLocked(db, true)
			http.Error(w, "Could not remove Guardian PIN.", 503)
			return
		}
	}
	accessMu.Lock()
	accessSessions = map[string]*pinSession{}
	accessMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "gameshelf-family", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
	logEvent("profile", "%s removed; linked profiles moved to role %s", id, roleID)
	profileReply(w, map[string]any{"saved": true, "profilesDisabled": last})
}
