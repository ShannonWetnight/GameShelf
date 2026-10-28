package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
)

func TestStandaloneGuardianCanSignInWithoutAProfile(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, nil)
	familyUnlock(t, "7392", []string{"admin"}, cookie)
	enabled := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "configure", "enabled": true}, cookie)
	if enabled.Code != 200 {
		t.Fatal(enabled.Code, enabled.Body.String())
	}
	public := familyCall(t, handleProfiles, "GET", "/api/profiles", nil, nil)
	var picker struct {
		Profiles []struct {
			ID, Nickname string
			Roles        []string
		}
		RoleNames map[string]string
	}
	if json.Unmarshal(public.Body.Bytes(), &picker) != nil || len(picker.Profiles) != 0 || picker.RoleNames["administrator"] != "Guardian" {
		t.Fatal("unexpected automatic Guardian profile", public.Body.String())
	}
	login := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": "guardian", "pin": "7392"}, nil)
	if login.Code != 200 {
		t.Fatal(login.Code, login.Body.String())
	}
	var pc *http.Cookie
	for _, c := range login.Result().Cookies() {
		if c.Name == "gameshelf-profile" {
			pc = c
		}
	}
	if pc == nil {
		t.Fatal("missing session")
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	if len(db.Profiles) != 0 {
		t.Error("virtual Guardian persisted")
	}
	profileMu.Unlock()
}

func TestAssociatedGuardianUsesCurrentPrivatePINWithoutCopyingVerifier(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, nil)
	familyUnlock(t, "7392", []string{"admin"}, cookie)
	required := true
	p := familyProfile{Nickname: "Owner", Roles: []string{"administrator"}, PINRequired: &required, UsesGuardianPIN: true, AllLibraries: true, AllGames: true, TourPending: true}
	saved := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": p}, cookie)
	if saved.Code != 200 {
		t.Fatal(saved.Code, saved.Body.String())
	}
	profileMu.Lock()
	db, err := readProfileDBLocked()
	for _, value := range db.Profiles {
		p = value
	}
	profileMu.Unlock()
	if err != nil || p.Hash != "" || p.Salt != "" || !p.UsesGuardianPIN {
		t.Fatal("copied private verifier", err)
	}
	header := base64.StdEncoding.EncodeToString([]byte("Aa safe family backup passphrase7!"))
	backup, err := encodeProfilesBackup(header)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := decodeProfilesBackup(backup, header)
	if err != nil || !restored.Profiles[p.ID].UsesGuardianPIN || !restored.Profiles[p.ID].TourPending {
		t.Fatal("association or tour lost", err)
	}
	first := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "7392"}, nil)
	if first.Code != 200 {
		t.Fatal(first.Code, first.Body.String())
	}
	var result struct{ ShowTour bool }
	json.Unmarshal(first.Body.Bytes(), &result)
	if !result.ShowTour {
		t.Fatal("first tour not offered")
	}
	second := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "7392"}, nil)
	json.Unmarshal(second.Body.Bytes(), &result)
	if result.ShowTour {
		t.Fatal("one-time tour repeated")
	}
	rotation := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "8642", "policy": accessPolicy{}}, cookie)
	// Profile sign-in clears only the caller's Guardian session; the management
	// browser above retains its own scoped approval until this rotation.
	if rotation.Code != 200 {
		t.Fatal(rotation.Code, rotation.Body.String())
	}
	if len(profileSessions) != 0 {
		t.Fatal("Guardian profile sessions survived rotation")
	}
	if bad := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "7392"}, nil); bad.Code != 401 {
		t.Fatal("old PIN accepted", bad.Code)
	}
	if good := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "8642"}, nil); good.Code != 200 {
		t.Fatal(good.Code, good.Body.String())
	}
}

func TestDisablingProfilesNeedsFreshGuardianApproval(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, nil)
	familyUnlock(t, "7392", []string{"admin"}, cookie)
	enableProfilesForTest(t)
	body := map[string]any{"operation": "configure", "enabled": false}
	if r := familyCall(t, handleProfiles, "POST", "/api/profiles", body, cookie); r.Code != 423 {
		t.Fatal("remembered PIN disabled profiles", r.Code)
	}
	token, _ := onePIN(t, cookie, []string{"admin"}, false)
	r := profileTestCall(t, http.HandlerFunc(handleProfiles), "POST", "/api/profiles", body, []*http.Cookie{cookie}, map[string]string{"X-GameShelf-PIN": token})
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
}
