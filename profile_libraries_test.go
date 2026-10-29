package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestGroupLibraryInheritanceAndIndividualLimits(t *testing.T) {
	db := defaultProfileDB()
	db.Groups["one"] = familyGroup{LibraryPolicy: "selected", Libraries: []string{"a", "b", "a"}}
	db.Groups["two"] = familyGroup{LibraryPolicy: "selected", Libraries: []string{"b", "c"}}
	db.Groups["all"] = familyGroup{LibraryPolicy: "all"}
	db.Groups["unset"] = familyGroup{Libraries: []string{"secret"}}
	db.Groups["empty"] = familyGroup{LibraryPolicy: "selected"}
	for _, tc := range []struct {
		name string
		p    familyProfile
		want []string
	}{
		{"legacy all", familyProfile{AllLibraries: true, Groups: []string{"one"}}, []string{"a", "b", "c", "secret", "future"}},
		{"legacy selected", familyProfile{Libraries: []string{"secret"}, Groups: []string{"all"}}, []string{"secret"}},
		{"union", familyProfile{InheritLibraries: true, AllLibraries: true, Groups: []string{"one", "two"}}, []string{"a", "b", "c"}},
		{"individual cap", familyProfile{InheritLibraries: true, Libraries: []string{"b", "secret"}, Groups: []string{"one", "two"}}, []string{"b"}},
		{"deny all cap", familyProfile{InheritLibraries: true, Groups: []string{"all"}}, nil},
		{"all still capped", familyProfile{InheritLibraries: true, Libraries: []string{"a"}, Groups: []string{"all"}}, []string{"a"}},
		{"future", familyProfile{InheritLibraries: true, AllLibraries: true, Groups: []string{"all", "one"}}, []string{"a", "b", "c", "secret", "future"}},
		{"unassigned", familyProfile{InheritLibraries: true, AllLibraries: true, Groups: []string{"missing", "unset", "empty"}}, nil},
		{"no membership", familyProfile{InheritLibraries: true, AllLibraries: true}, nil},
		{"Guardian", familyProfile{UsesGuardianPIN: true, InheritLibraries: true, AllLibraries: true, Groups: []string{"one"}}, []string{"a", "b", "c", "secret", "future"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before, _ := json.Marshal(tc.p)
			tc.p.AllGames = true
			p := effectiveProfileLibraries(db, tc.p)
			r := httptest.NewRequest("GET", "/api/games", nil)
			r = r.WithContext(context.WithValue(r.Context(), profileContextKey{}, &profileContext{Profile: p}))
			for _, library := range []string{"a", "b", "c", "secret", "future"} {
				entry := &gameEntry{NetworkID: library, Game: Game{ID: "game"}}
				if profileAllows(r, entry) != containsProfileID(tc.want, library) {
					t.Fatalf("unexpected access to %s: %+v", library, p)
				}
			}
			tc.p.AllGames = false
			after, _ := json.Marshal(tc.p)
			if !bytes.Equal(before, after) {
				t.Fatal("saved profile mutated")
			}
		})
	}
	p := effectiveProfileLibraries(db, familyProfile{InheritLibraries: true, AllLibraries: true, Groups: []string{"one"}, Games: []string{"permitted"}})
	r := httptest.NewRequest("GET", "/", nil)
	r = r.WithContext(context.WithValue(r.Context(), profileContextKey{}, &profileContext{Profile: p}))
	if profileAllows(r, &gameEntry{NetworkID: "a", Game: Game{ID: "blocked"}}) || profileAllows(r, &gameEntry{NetworkID: "secret", Game: Game{ID: "permitted"}}) {
		t.Fatal("group bypassed game or library limit")
	}
	if !profileAllows(r, &gameEntry{NetworkID: "a", Game: Game{ID: "permitted"}}) {
		t.Fatal("permitted game denied")
	}
}

func TestGroupLibrariesGateEndpointsAndRevokeSessions(t *testing.T) {
	root, _ := setupFreshServer(t)
	profileAttempts = map[string]pinBudget{}
	rootDir, rootDirs = root, []string{root}
	writeGame(t, "Allowed")
	writeGame(t, "Hidden")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	// The hidden game belongs to another (network) library.
	gamesMu.Lock()
	gamesMap["hidden"].NetworkID = "private-library"
	gamesMu.Unlock()
	p := createProfileForTest(t, "Shared", []string{"child"})
	group := familyGroup{ID: "g-test", Name: "Shared", Roles: []string{"child"}, LibraryPolicy: "selected", Libraries: []string{localLibraryID(root)}}
	change := func(members []string) {
		t.Helper()
		w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "group", "group": group, "members": members}, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	change([]string{p.ID})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	p = copy.Profiles[p.ID]
	p.InheritLibraries = true
	copy.Profiles[p.ID] = p
	err := saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	enableProfilesForTest(t)
	cookie := profileLoginTest(t, p.ID, nil)
	gate := profileGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, path := range []string{"/covers/hidden", "/download/hidden", "/api/game-files/hidden", "/api/game-file/hidden", "/api/favorite/hidden", "/download-cart?game=allowed&game=hidden", "/download-playlist?game=hidden"} {
		if w := profileTestCall(t, gate, "GET", path, nil, []*http.Cookie{cookie}, nil); w.Code != 404 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	if w := profileTestCall(t, gate, "GET", "/download/allowed", nil, []*http.Cookie{cookie}, nil); w.Code != 204 {
		t.Fatal(w.Code)
	}
	w := profileTestCall(t, profileGate(http.HandlerFunc(handleGames)), "GET", "/api/games", nil, []*http.Cookie{cookie}, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "hidden") || !strings.Contains(w.Body.String(), "allowed") {
		t.Fatal(w.Code, w.Body.String())
	}
	private := profileGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value := profileSafeSettings(r, serverSettings{RootDir: "secret", DataDir: "secret"})
		if value.RootDir != "" || value.DataDir != "" || policyMode(combinedAccessPolicy(r, nil), "health") != "disable" {
			t.Fatal("inherited restrictions leaked configuration")
		}
		w.WriteHeader(204)
	}))
	profileTestCall(t, private, "GET", "/api/server-settings", nil, []*http.Cookie{cookie}, nil)
	personal := profileGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := saveProfilePreferences(r, map[string]string{"theme": "midnight"}); err != nil {
			t.Fatal(err)
		}
		saveProfileFavorite(w, r, "allowed", true)
	}))
	profileTestCall(t, personal, "PUT", "/api/favorite/allowed", nil, []*http.Cookie{cookie}, nil)
	profileMu.Lock()
	db, _ = readProfileDBLocked()
	saved := db.Profiles[p.ID]
	profileMu.Unlock()
	if !saved.AllLibraries || len(saved.Libraries) != 0 || !saved.InheritLibraries || !saved.Favorites["allowed"] {
		t.Fatal("personal changes overwrote the saved individual limits", saved)
	}
	// Editing group grants invalidates the old cookie; a fresh login uses new access.
	group.Libraries = []string{"private-library"}
	change([]string{p.ID})
	if w := profileTestCall(t, gate, "GET", "/download/allowed", nil, []*http.Cookie{cookie}, nil); w.Code != 401 {
		t.Fatal("grant edit retained session", w.Code)
	}
	cookie = profileLoginTest(t, p.ID, nil)
	if w := profileTestCall(t, gate, "GET", "/download/allowed", nil, []*http.Cookie{cookie}, nil); w.Code != 404 {
		t.Fatal("old grant survived", w.Code)
	}
	if w := profileTestCall(t, gate, "GET", "/download/hidden", nil, []*http.Cookie{cookie}, nil); w.Code != 204 {
		t.Fatal("new grant missing", w.Code)
	}
	change(nil)
	if w := profileTestCall(t, gate, "GET", "/download/hidden", nil, []*http.Cookie{cookie}, nil); w.Code != 401 {
		t.Fatal("membership edit retained session", w.Code)
	}
	cookie = profileLoginTest(t, p.ID, nil)
	if w := profileTestCall(t, gate, "GET", "/download/hidden", nil, []*http.Cookie{cookie}, nil); w.Code != 404 {
		t.Fatal("removed member retained libraries", w.Code)
	}
}

func TestGroupLibrariesBackupMigrationValidationAndRecovery(t *testing.T) {
	setupFreshServer(t)
	profileAttempts = map[string]pinBudget{}
	p := createProfileForTest(t, "Backup", []string{"child"})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	group := familyGroup{ID: "g-shared", Name: "Shared", Roles: []string{"child"}, LibraryPolicy: "selected", Libraries: []string{"a", "offline-library"}}
	copy.Groups[group.ID] = group
	p.Groups = []string{group.ID}
	p.Roles = nil
	p.InheritLibraries = true
	p.AllLibraries = false
	p.Libraries = []string{"a", "b"}
	copy.Profiles[p.ID] = p
	err := saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"", base64.StdEncoding.EncodeToString([]byte("Recovery1!"))} {
		backup, err := encodeProfilesBackup(key)
		if err != nil {
			t.Fatal(err)
		}
		restored, err := decodeProfilesBackup(backup, key)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(restored.Groups[group.ID], group) || !reflect.DeepEqual(restored.Profiles[p.ID], p) {
			t.Fatal("backup lost library policy or individual exceptions")
		}
		if got := effectiveProfileLibraries(restored, restored.Profiles[p.ID]); !reflect.DeepEqual(got.Libraries, []string{"a"}) {
			t.Fatal("recovery changed access", got)
		}
		// Apply through the archive restore handler, not just the decoder.
		archive := restoreZIP(t, map[string][]byte{"family-profiles.enc.json": backup})
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/api/library-restore", bytes.NewReader(archive))
		r.Header.Set("X-GameShelf-Backup-Key", key)
		handleLibraryRestore(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var summary struct{ SHA256 string }
		json.Unmarshal(w.Body.Bytes(), &summary)
		r = httptest.NewRequest("POST", "/api/library-restore?apply=1&profiles=1", bytes.NewReader(archive))
		profileSessions["old-session"] = profileSession{Home: settingsHome, Profile: p.ID}
		r.Header.Set("X-Preview-SHA256", summary.SHA256)
		r.Header.Set("X-GameShelf-Backup-Key", key)
		w = httptest.NewRecorder()
		handleLibraryRestore(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		if len(profileSessions) != 0 {
			t.Fatal("restore retained stale profile sessions")
		}
		profileMu.Lock()
		recovered, err := readProfileDBLocked()
		actual := cloneProfileDB(recovered)
		profileMu.Unlock()
		if err != nil || !reflect.DeepEqual(actual.Groups[group.ID], group) || !actual.Profiles[p.ID].InheritLibraries {
			t.Fatal("archive recovery lost assignments", err)
		}
	}
	legacy := defaultProfileDB()
	p.InheritLibraries = false
	p.Groups = nil
	p.Roles = []string{"child"}
	legacy.Profiles[p.ID] = p
	data, _ := json.Marshal(legacy)
	if err := os.WriteFile(profilePath(), data, 0600); err != nil {
		t.Fatal(err)
	}
	profileCache = nil
	profileMu.Lock()
	migrated, err := readProfileDBLocked()
	profileMu.Unlock()
	if err != nil || !reflect.DeepEqual(migrated.Profiles[p.ID], p) {
		t.Fatal("legacy limits changed", err)
	}
	for _, bad := range []familyGroup{
		{ID: "g-bad", Name: "Bad", Roles: []string{"child"}, LibraryPolicy: "typo"},
		{ID: "g-bad", Name: "Bad", Roles: []string{"child"}, LibraryPolicy: "selected", Libraries: []string{"bad\nID"}},
		{ID: "g-guardians", Name: "Guardians", Roles: []string{"administrator"}, LibraryPolicy: "selected"},
	} {
		invalid := cloneProfileDB(legacy)
		invalid.Groups[bad.ID] = bad
		if validateProfileDB(invalid) == nil {
			t.Fatal("invalid assignment accepted", bad)
		}
		data, _ := json.Marshal(protectedProfiles{Version: 2, Plain: invalid})
		if _, err := decodeProfilesBackup(data, ""); err == nil {
			t.Fatal("invalid backup accepted")
		}
	}
}
