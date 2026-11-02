package main

import "testing"

func TestManagementColorsAndRoleMetadataPersistThroughBackup(t *testing.T) {
	setupFreshServer(t)
	role := familyRole{ID: "r-color", Name: "Color role", Color: "#c052bb", Template: "adult", Rules: map[string]accessRule{
		"theme": {Mode: "pin", Hidden: true, Level: "advanced"},
		"wipe":  {Mode: "allow", Hidden: true, Level: "basic"},
	}}
	w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "role", "role": role}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	group := familyGroup{ID: "g-color", Name: "Color group", Color: "#128a96", Roles: []string{"child"}, LibraryPolicy: "all"}
	w = familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": group}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data, err := encodeProfilesBackup("")
	if err != nil {
		t.Fatal(err)
	}
	restored, err := decodeProfilesBackup(data, "")
	if err != nil {
		t.Fatal(err)
	}
	got := restored.Roles[role.ID]
	if got.Color != role.Color || got.Rules["theme"] != role.Rules["theme"] || restored.Groups[group.ID].Color != group.Color {
		t.Fatal("role/group presentation or settings were lost", got, restored.Groups[group.ID])
	}
	rules := mergedProfileRules(restored, familyProfile{Roles: []string{role.ID}})
	if rules["theme"] != role.Rules["theme"] {
		t.Fatal("role category/visibility did not reach effective permissions", rules["theme"])
	}
	if rules["wipe"] != (accessRule{Mode: "guardian", Hidden: true, Level: "basic"}) {
		t.Fatal("Wipe lost its Guardian requirement or presentation settings", rules["wipe"])
	}
	for _, invalid := range []string{"red", "#123", "#12345678", "#zzzzzz", "#123456;display:none"} {
		role.Color = invalid
		if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "role", "role": role}, nil); w.Code != 400 {
			t.Fatal("invalid role color accepted", invalid, w.Code)
		}
		group.Color = invalid
		if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": group}, nil); w.Code != 400 {
			t.Fatal("invalid group color accepted", invalid, w.Code)
		}
	}
}

func TestGuardianManagementRemainsBasicAndBrandingIsFixed(t *testing.T) {
	db := defaultProfileDB()
	rules := mergedProfileRules(db, familyProfile{Roles: []string{"administrator"}, UsesGuardianPIN: true})
	for _, action := range []string{"admin", "libraryManager"} {
		if rules[action].Mode != "allow" || rules[action].Level != "basic" {
			t.Fatal("Guardian shortcut requires Advanced settings", action, rules[action])
		}
		dependencies := accessDependencies(&accessPolicy{Rules: rules}, []string{action}, true)
		if containsProfileID(dependencies, "advanced") {
			t.Fatal("basic shortcut unexpectedly depends on Advanced", action, dependencies)
		}
	}
	if rules["wipe"].Mode != "guardian" {
		t.Fatal("Guardian profile bypassed Wipe protection")
	}
	setupFreshServer(t)
	w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "role", "role": familyRole{ID: "administrator", Name: "Guardian", Color: "#ff0000"}}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": familyGroup{ID: "g-guardians", Name: "Guardians", Color: "#ff0000"}}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	saved, err := readProfileDBLocked()
	if err != nil {
		t.Fatal(err)
	}
	if saved.Roles["administrator"].Color != "" || saved.Groups["g-guardians"].Color != "" {
		t.Fatal("Guardian branding can be overridden")
	}
}
