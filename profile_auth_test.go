package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
)

func TestProfileOptionalPINRestrictedShelfAndProtectedBackup(t *testing.T) {
	setupFreshServer(t)
	disabled := false
	profile := familyProfile{Nickname: "Open Child Shelf", Roles: []string{"child"}, PINRequired: &disabled, AllLibraries: true, AllGames: true}
	saved := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": profile}, nil)
	if saved.Code != 200 {
		t.Fatal(saved.Code, saved.Body.String())
	}
	profileMu.Lock()
	db, err := readProfileDBLocked()
	profileMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range db.Profiles {
		profile = p
	}
	if profileRequiresPIN(profile) || profile.Hash != "" || profile.Salt != "" {
		t.Fatal("open shelf retained a verifier")
	}
	familyCreate(t, nil)
	enableProfilesForTest(t)
	login := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": profile.ID}, nil)
	if login.Code != 200 {
		t.Fatal("optional profile required a PIN", login.Code, login.Body.String())
	}
	var cookie *http.Cookie
	for _, item := range login.Result().Cookies() {
		if item.Name == "gameshelf-profile" {
			cookie = item
		}
	}
	blocked := profileTestCall(t, profileGate(accessGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Fatal("open shelf gained administrative access") }))), "POST", "/api/network-test", nil, []*http.Cookie{cookie}, nil)
	if blocked.Code != 403 {
		t.Fatal("open shelf bypassed restrictions", blocked.Code)
	}
	key := base64.StdEncoding.EncodeToString([]byte("optional profile backup secret"))
	data, err := encodeProfilesBackup(key)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := decodeProfilesBackup(data, key)
	if err != nil || profileRequiresPIN(restored.Profiles[profile.ID]) {
		t.Fatal("optional PIN lost in backup", err)
	}
}

func TestProfileAdministrativePermissionsCannotBypassPIN(t *testing.T) {
	setupFreshServer(t)
	disabled := false
	for _, role := range []string{"administrator", "adult", "elevated"} {
		r := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": familyProfile{Nickname: role, Roles: []string{role}, PINRequired: &disabled}}, nil)
		if r.Code != 400 {
			t.Fatal("administrative role accepted without PIN", role, r.Code)
		}
	}
	child := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": familyProfile{Nickname: "Child", Roles: []string{"child"}, PINRequired: &disabled}}, nil)
	if child.Code != 200 {
		t.Fatal(child.Body.String())
	}
	// Upgrading a shared role must fail atomically until its open profiles get PINs.
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	role := cloneProfileDB(db).Roles["child"]
	profileMu.Unlock()
	role.Rules["settings"] = accessRule{Mode: "allow"}
	change := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "role", "role": role}, nil)
	if change.Code != 400 {
		t.Fatal("role upgrade bypassed PIN", change.Code)
	}
	profileMu.Lock()
	after, _ := readProfileDBLocked()
	profileMu.Unlock()
	if after.Roles["child"].Rules["settings"].Mode != "disable" {
		t.Fatal("rejected upgrade changed stored permissions")
	}
}

func TestProfileLegacyPINAndRequiringPINAgain(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Legacy", []string{"child"})
	if !profileRequiresPIN(p) {
		t.Fatal("legacy profile lost its PIN requirement")
	}
	if r := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID}, nil); r.Code == 200 {
		t.Fatal("legacy profile accepted empty PIN")
	}
	off := false
	p.PINRequired = &off
	if r := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": p}, nil); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	on := true
	p.PINRequired = &on
	if r := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": p}, nil); r.Code != 400 {
		t.Fatal("re-enabled PIN without creating one", r.Code)
	}
	saved := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": p, "pin": "1357", "confirmPIN": "1357"}, nil)
	if saved.Code != 200 {
		t.Fatal(saved.Body.String())
	}
	login := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "1357"}, nil)
	if login.Code != 200 {
		t.Fatal(login.Code, login.Body.String())
	}
	listed := familyCall(t, handleProfiles, "GET", "/api/profiles", nil, nil)
	var view struct {
		Profiles []struct {
			PINRequired bool `json:"pinRequired"`
		}
	}
	json.Unmarshal(listed.Body.Bytes(), &view)
	if len(view.Profiles) != 1 || !view.Profiles[0].PINRequired {
		t.Fatal("picker did not advertise PIN requirement")
	}
}
