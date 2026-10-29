package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLibraryViewRedactsDetailsAndMatchesEffectiveAccess(t *testing.T) {
	root, _ := setupFreshServer(t)
	previousSources := snapshotSources()
	setActiveSources(nil)
	t.Cleanup(func() { setActiveSources(previousSources) })
	rootDir, rootDirs = root, []string{root, t.TempDir()}
	configuredSettings.RootDir, configuredSettings.RootDirs = rootDir, rootDirs
	source := networkSource{ID: "private-source", Name: "Private Archive", Protocol: "smb", URL: "smb://private-server/share", Username: "private-user"}
	writeGame(t, "Allowed")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	setActiveSources([]networkSource{source})
	gamesMu.Lock()
	gamesMap["private"] = &gameEntry{Game: Game{ID: "private", Name: "Secret Game"}, NetworkID: source.ID}
	gamesMu.Unlock()
	active := activeHealthSources()
	healthMu.Lock()
	healthHome = dataDir
	healthData = healthArchive{Version: 1, Sources: active}
	for i := range healthData.Sources {
		healthData.Sources[i].State = "healthy"
		healthData.Sources[i].Message = "private diagnostics and credentials"
	}
	healthMu.Unlock()
	t.Cleanup(resetHealthCache)
	get := func(p *familyProfile) []libraryView {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/libraries", nil)
		if p != nil {
			r = r.WithContext(context.WithValue(r.Context(), profileContextKey{}, &profileContext{Profile: *p}))
		}
		w := httptest.NewRecorder()
		handleLibraryView(w, r)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code, w.Body.String())
		}
		for _, secret := range []string{"private-server", "smb://", "private-user", "private diagnostics", "identity", "location", root} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("descriptor leaked connection details", w.Body.String())
			}
		}
		var list []libraryView
		if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		return list
	}
	list := get(nil)
	if len(list) != 3 {
		t.Fatal("missing configured sources", list)
	}
	for _, library := range list {
		if library.State != "healthy" {
			t.Fatal("cached health lost", library)
		}
	}
	db := defaultProfileDB()
	db.Groups["g-shared"] = familyGroup{LibraryPolicy: "selected", Libraries: []string{localLibraryID(root)}}
	p := effectiveProfileLibraries(db, familyProfile{InheritLibraries: true, AllLibraries: true, AllGames: true, Groups: []string{"g-shared"}})
	list = get(&p)
	if len(list) != 1 || list[0].ID != localLibraryID(root) || list[0].Games != 1 {
		t.Fatal("group boundaries not applied", list)
	}
	p.AllGames = false
	p.Games = []string{"private"}
	if list = get(&p); len(list) != 0 {
		t.Fatal("game limits revealed a library without allowed games", list)
	}
	p.AllLibraries = true
	list = get(&p)
	if len(list) != 1 || list[0].ID != source.ID {
		t.Fatal("individual game selection not reflected", list)
	}
	guardian := standaloneGuardian()
	if list = get(&guardian); len(list) != 3 {
		t.Fatal("Guardian lost source visibility", list)
	}
	configuredSettings.Health = &healthOptions{Enabled: false, IntervalSeconds: 300}
	for _, library := range get(nil) {
		if library.State != "disabled" {
			t.Fatal("disabled monitoring presented as current", library)
		}
	}
	configuredSettings.Health = nil
	configuredSettings.Access = &accessPolicy{Rules: map[string]accessRule{"healthView": {Mode: "disable"}}}
	for _, library := range get(nil) {
		if library.State != "restricted" {
			t.Fatal("health policy was bypassed", library)
		}
	}
	configuredSettings.Access = nil
	healthMu.Lock()
	for i := range healthData.Sources {
		healthData.Sources[i].Identity = "stale"
	}
	healthMu.Unlock()
	for _, library := range get(nil) {
		if library.State != "unknown" {
			t.Fatal("stale source health reused", library)
		}
	}
	setActiveSources(nil)
	if list = get(nil); len(list) != 2 {
		t.Fatal("removed source remained visible", list)
	}
	w := httptest.NewRecorder()
	handleLibraryView(w, httptest.NewRequest("POST", "/api/libraries", nil))
	if w.Code != 405 {
		t.Fatal("unexpected method accepted", w.Code)
	}
}

func TestLibraryViewRequiresProfileAndGamesExposeOnlyAllowedLibraryIDs(t *testing.T) {
	root, _ := setupFreshServer(t)
	previousSources := snapshotSources()
	setActiveSources(nil)
	t.Cleanup(func() { setActiveSources(previousSources) })
	profileAttempts = map[string]pinBudget{}
	rootDir, rootDirs = root, []string{root}
	configuredSettings.RootDir = root
	configuredSettings.RootDirs = rootDirs
	writeGame(t, "Allowed")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	gamesMu.Lock()
	gamesMap["hidden"] = &gameEntry{Game: Game{ID: "hidden", Name: "Private"}, NetworkID: "secret"}
	gamesMu.Unlock()
	p := createProfileForTest(t, "Scoped", []string{"child"})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	p.InheritLibraries = true
	p.Groups = []string{"g-test"}
	p.Roles = nil
	copy.Groups["g-test"] = familyGroup{ID: "g-test", Name: "Test", Roles: []string{"child"}, LibraryPolicy: "selected", Libraries: []string{localLibraryID(root)}}
	copy.Profiles[p.ID] = p
	err := saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	enableProfilesForTest(t)
	gate := profileGate(http.HandlerFunc(handleLibraryView))
	if w := profileTestCall(t, gate, "GET", "/api/libraries", nil, nil, nil); w.Code != 401 {
		t.Fatal("anonymous source visibility", w.Code)
	}
	cookie := profileLoginTest(t, p.ID, nil)
	w := profileTestCall(t, gate, "GET", "/api/libraries", nil, []*http.Cookie{cookie}, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), localLibraryID(root)) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = profileTestCall(t, profileGate(http.HandlerFunc(handleGames)), "GET", "/api/games", nil, []*http.Cookie{cookie}, nil)
	var games []Game
	json.Unmarshal(w.Body.Bytes(), &games)
	if w.Code != 200 || len(games) != 1 || games[0].LibraryID != localLibraryID(root) {
		t.Fatal("game source association unavailable", w.Code, w.Body.String())
	}
}
