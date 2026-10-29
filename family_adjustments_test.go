package main

import (
	"reflect"
	"testing"
)

func TestDefaultGroupsMigrateOnceAndPreserveEdits(t *testing.T) {
	db := defaultProfileDB()
	if len(db.Groups) != 3 || db.Groups["g-guardians"].Roles[0] != "administrator" {
		t.Fatal("missing default groups", db.Groups)
	}
	db.GroupDefaultsVersion = 0
	db.Groups = map[string]familyGroup{"club": {ID: "club", Name: "Club", Roles: []string{"child"}}}
	migrateFamilyRoles(db)
	if len(db.Groups) != 4 || db.GroupDefaultsVersion != 1 {
		t.Fatal("default migration lost existing groups", db.Groups)
	}
	g := db.Groups["g-adults"]
	g.Name = "Household"
	db.Groups[g.ID] = g
	migrateFamilyRoles(db)
	if db.Groups[g.ID].Name != "Household" {
		t.Fatal("migration replaced a saved group name")
	}
}

func TestGuardianMembershipOnlyChangesThroughGuardianWorkflow(t *testing.T) {
	setupFreshServer(t)
	c := familyCreate(t, nil)
	familyUnlock(t, "7392", []string{"admin"}, c)
	p := familyProfile{Nickname: "Pat", Roles: []string{"administrator"}, UsesGuardianPIN: true, GuardianID: "guardian-1", AllLibraries: true, AllGames: true}
	for _, operation := range []string{"profile", "linkGuardian"} {
		w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": operation, "profile": p}, c)
		want := 200
		if operation == "profile" {
			want = 400
		}
		if w.Code != want {
			t.Fatal(operation, w.Code, w.Body.String())
		}
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	for _, item := range db.Profiles {
		p = item
	}
	profileMu.Unlock()
	if !reflect.DeepEqual(p.Groups, []string{"g-guardians"}) || !reflect.DeepEqual(p.Roles, []string{"administrator"}) || !profileRequiresPIN(p) {
		t.Fatal("Guardian access was not fixed", p)
	}
	plain := p
	plain.UsesGuardianPIN = false
	plain.GuardianID = ""
	plain.Roles = []string{"child"}
	plain.Groups = nil
	required := false
	plain.PINRequired = &required
	for _, operation := range []string{"profile", "unlinkGuardian"} {
		w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": operation, "profile": plain}, c)
		want := 200
		if operation == "profile" {
			want = 400
		}
		if w.Code != want {
			t.Fatal(operation, w.Code, w.Body.String())
		}
	}
	if !guardianAvailable() {
		t.Fatal("unlink removed the private Guardian credential")
	}
	plain.Roles = []string{"administrator"}
	if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": plain}, c); w.Code != 400 {
		t.Fatal("ordinary editor assigned Guardian role", w.Code)
	}
}

func TestGuardianPermissionsAndGroupMembershipAreImmutable(t *testing.T) {
	setupFreshServer(t)
	role := defaultProfileDB().Roles["administrator"]
	role.Name = "Shelf Guardians"
	role.Rules["settings"] = accessRule{Mode: "disable"}
	w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "role", "role": role}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	saved := db.Roles["administrator"]
	profileMu.Unlock()
	if saved.Name != role.Name || saved.Rules["settings"].Mode != "allow" {
		t.Fatal("Guardian permissions changed", saved)
	}
	for _, id := range []string{"", "g-adults"} {
		group := familyGroup{ID: id, Name: "Custom Guardians", Roles: []string{"administrator"}}
		if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": group, "acknowledgeAdmin": true}, nil); w.Code != 400 {
			t.Fatal("ordinary group editor assigned Guardian membership", w.Code)
		}
	}
	for _, id := range []string{"g-guardians", "g-adults", "g-children"} {
		if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "deleteGroup", "group": familyGroup{ID: id}}, nil); w.Code != 409 {
			t.Fatal("default group removed", id, w.Code)
		}
	}
}

func TestDefaultGroupResetPreservesMembersAndAdminSelectionRequiresConsent(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Jamie", []string{"child"})
	group := familyGroup{ID: "g-adults", Name: "Everyone", Roles: []string{"child"}}
	w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": group, "members": []string{p.ID}}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "resetGroup", "group": group}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	saved, member := db.Groups[group.ID], db.Profiles[p.ID]
	profileMu.Unlock()
	if saved.Name != "Adults" || !reflect.DeepEqual(saved.Roles, []string{"adult"}) || !containsProfileID(member.Groups, group.ID) {
		t.Fatal("reset lost defaults or membership", saved, member)
	}
	// A custom role granting administration requires explicit confirmation even with no members yet.
	group = familyGroup{Name: "Administrators", Roles: []string{"adult"}}
	profileMu.Lock()
	db, _ = readProfileDBLocked()
	copy := cloneProfileDB(db)
	role := copy.Roles["adult"]
	role.Rules["admin"] = accessRule{Mode: "allow"}
	copy.Roles[role.ID] = role
	err := saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": group}, nil); w.Code != 400 {
		t.Fatal("administrative group skipped confirmation", w.Code)
	}
}
