package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestPersonalApprovalCannotBecomeGuardianApproval(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Personal", []string{"child"})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	role := copy.Roles["child"]
	role.Rules["theme"] = accessRule{Mode: "pin"}
	role.Rules["downloads"] = accessRule{Mode: "guardian"}
	copy.Roles[role.ID] = role
	copy.Enabled = true
	err := saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	c := familyCreate(t, nil)
	pc := profileLoginTest(t, p.ID, nil)
	unlock := profileGate(http.HandlerFunc(handleAccessUnlock))
	w := profileTestCall(t, unlock, "POST", "/api/access/unlock", map[string]any{"pin": "2468", "actions": []string{"theme"}, "remember": true}, []*http.Cookie{c, pc}, nil)
	if w.Code != 200 {
		t.Fatal("personal PIN rejected", w.Code, w.Body.String())
	}
	gate := profileGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if checkAccess(w, r, []string{"theme"}) {
			w.WriteHeader(204)
		}
	}))
	if w := profileTestCall(t, gate, "GET", "/api/settings-events", nil, []*http.Cookie{c, pc}, nil); w.Code != 204 {
		t.Fatal("personal approval unavailable", w.Code)
	}
	for _, action := range []string{"downloads", "wipe", "admin"} {
		w := profileTestCall(t, unlock, "POST", "/api/access/unlock", map[string]any{"pin": "2468", "actions": []string{action}}, []*http.Cookie{c, pc}, nil)
		if w.Code != 401 {
			t.Fatal("personal PIN authorized Guardian action", action, w.Code, w.Body.String())
		}
	}
	w = profileTestCall(t, unlock, "POST", "/api/access/unlock", map[string]any{"pin": "7392", "actions": []string{"downloads"}, "remember": true}, []*http.Cookie{c, pc}, nil)
	if w.Code != 200 {
		t.Fatal("Guardian could not approve", w.Code, w.Body.String())
	}
}

func TestGroupsAssignmentsDefaultsAndBackupRoundTrip(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Grouped", []string{"child"})
	w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": familyGroup{ID: "g-house", Name: "Household", Roles: []string{"adult", "child"}}, "members": []string{p.ID}, "acknowledgeAdmin": true}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	p = db.Profiles[p.ID]
	rules := mergedProfileRules(db, p)
	profileMu.Unlock()
	if !containsProfileID(p.Groups, "g-house") || p.AllowMultipleRoles || rules["settings"].Mode != "allow" || rules["wipe"].Mode != "guardian" {
		t.Fatal("group grants missing", p, rules)
	}
	data, err := encodeProfilesBackup("")
	if err != nil {
		t.Fatal(err)
	}
	restored, err := decodeProfilesBackup(data, "")
	if err != nil || restored.Groups["g-house"].Name != "Household" {
		t.Fatal("groups lost in backup", err)
	}
	if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "deleteRole", "role": familyRole{ID: "adult"}}, nil); w.Code != 409 {
		t.Fatal("built-in role removed", w.Code)
	}
	w = familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "resetRole", "role": familyRole{ID: "adult"}}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAdministrativePINWaiverIsExplicitAndCannotChangeWipe(t *testing.T) {
	setupFreshServer(t)
	required := false
	p := familyProfile{Nickname: "Open Adult", Roles: []string{"adult"}, PINRequired: &required, AllLibraries: true, AllGames: true, UnprotectedAdmin: true}
	body := map[string]any{"operation": "profile", "profile": p}
	if w := familyCall(t, handleProfiles, "POST", "/api/profiles", body, nil); w.Code != 400 {
		t.Fatal("waiver accepted without acknowledgment", w.Code)
	}
	body["acknowledgeAdmin"] = true
	if w := familyCall(t, handleProfiles, "POST", "/api/profiles", body, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	role := db.Roles["adult"]
	profileMu.Unlock()
	role.Rules["wipe"] = accessRule{Mode: "allow"}
	if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "role", "role": role}, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	profileMu.Lock()
	db, _ = readProfileDBLocked()
	wipe := db.Roles["adult"].Rules["wipe"].Mode
	profileMu.Unlock()
	if wipe != "guardian" {
		t.Fatal("Wipe lost Guardian requirement")
	}
}

func TestRemoveGuardianPreservesOtherIdentityAndLastRemovalNeedsConsent(t *testing.T) {
	setupFreshServer(t)
	c := familyCreate(t, nil)
	familyUnlock(t, "7392", []string{"admin"}, c)
	record, _ := readPINRecord()
	if err := setGuardianCredential(record, "guardian-2", "8642"); err != nil {
		t.Fatal(err)
	}
	record.GuardianName = "Pat"
	record.Secondary.Name = "Sam"
	if err := savePrivateJSON(pinPath(), record); err != nil {
		t.Fatal(err)
	}
	if err := autoGuardianProfile("guardian-1"); err != nil {
		t.Fatal(err)
	}
	w := familyCall(t, handleAccess, "DELETE", "/api/access?guardianID=guardian-1&role=adult", nil, c)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	record, _ = readPINRecord()
	if matchGuardianPIN(record, "7392", "") != "" || matchGuardianPIN(record, "8642", "") != "guardian-2" {
		t.Fatal("removed Guardian still authenticates or other identity changed")
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	for _, p := range db.Profiles {
		if p.UsesGuardianPIN || !containsProfileID(p.Roles, "adult") || profileRequiresPIN(p) {
			t.Fatal("profile not migrated", p)
		}
	}
	profileMu.Unlock()
	w = familyUnlock(t, "8642", []string{"admin"}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	c = cookieNamed(t, w, "gameshelf-family")
	if w := familyCall(t, handleAccess, "DELETE", "/api/access?guardianID=guardian-2&role=adult", nil, c); w.Code != 409 {
		t.Fatal("last Guardian removed without consent", w.Code)
	}
	w = familyCall(t, handleAccess, "DELETE", "/api/access?guardianID=guardian-2&role=adult&disableProfiles=1", nil, c)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result map[string]bool
	json.Unmarshal(w.Body.Bytes(), &result)
	if !result["profilesDisabled"] {
		t.Fatal("missing disabled result")
	}
	if record, _ := readPINRecord(); record != nil {
		t.Fatal("last Guardian retained")
	}
	profileMu.Lock()
	db, _ = readProfileDBLocked()
	disabled := !db.Enabled
	count := len(db.Profiles)
	profileMu.Unlock()
	if !disabled || count != 1 {
		t.Fatal("saved profiles lost or remain enabled")
	}
}
