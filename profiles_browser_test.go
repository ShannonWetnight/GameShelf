package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
)

// Opt-in live integration uses real handlers, cookies, JavaScript and Chrome.
// The normal container suite separately exercises server and browser regressions.
func TestFamilyProfilesLiveBrowser(t *testing.T) {
	if os.Getenv("GAMESHELF_LIVE_PROFILES") != "1" {
		t.Skip("set GAMESHELF_LIVE_PROFILES=1 with Node and Chrome installed")
	}
	root, _ := setupFreshServer(t)
	rootDir, rootDirs = root, []string{root}
	configuredSettings.RootDir = root
	configuredSettings.RootDirs = []string{root}
	writeGame(t, "Allowed")
	writeGame(t, "Hidden")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	profileAttempts = map[string]pinBudget{}
	p := createProfileForTest(t, "Jamie", []string{"child"})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	p.InheritLibraries = true
	p.Groups = []string{"g-live"}
	p.Roles = nil
	p.AllGames = true
	copy.Groups["g-live"] = familyGroup{ID: "g-live", Name: "Family Library", Roles: []string{"child"}, LibraryPolicy: "selected", Libraries: []string{localLibraryID(root)}}
	copy.Profiles[p.ID] = p
	saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	gamesMu.Lock()
	gamesMap["hidden"].NetworkID = "restricted-library"
	gamesMu.Unlock()
	familyCreate(t, nil)
	enableProfilesForTest(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/profiles", handleProfiles)
	mux.HandleFunc("/api/profiles/login", handleProfileLogin)
	mux.HandleFunc("/api/profiles/logout", handleProfileLogout)
	mux.HandleFunc("/api/profiles/catalog", handleProfileCatalog)
	mux.HandleFunc("/api/profiles/self", handleProfileSelf)
	mux.HandleFunc("/api/profiles/self/open", handleProfileSelf)
	mux.HandleFunc("/api/access", handleAccess)
	mux.HandleFunc("/api/access/unlock", handleAccessUnlock)
	mux.HandleFunc("/api/access/enter", handleAccessEnter)
	mux.HandleFunc("/api/access/leave", handleAccessLeave)
	mux.HandleFunc("/api/setup", handleSetup)
	mux.HandleFunc("/api/games", handleGames)
	mux.HandleFunc("/api/libraries", handleLibraryView)
	mux.HandleFunc("/api/server-settings", handleServerSettings)
	mux.HandleFunc("/api/version", handleVersion)
	mux.HandleFunc("/api/source-status", handleSourceStatus)
	mux.HandleFunc("/api/settings-events", handleSettingsEvent)
	mux.HandleFunc("/api/favorite/", handleFavorite)
	mux.HandleFunc("/covers/", handleCover)
	mux.HandleFunc("/download/", handleDownload)
	sub, err := embedSubFS(webFS, "web")
	if err != nil {
		t.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))
	server := httptest.NewServer(setupGate(profileGate(accessGate(mux))))
	defer server.Close()
	command := exec.Command("node", "tests/profiles-live.cjs", server.URL)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("live profiles: %v\n%s", err, output)
	}
	t.Log(string(output))
}
