package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func profileTestCall(t *testing.T, handler http.Handler, method, path string, value any, cookies []*http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	if value != nil {
		if err := json.NewEncoder(&body).Encode(value); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, &body)
	r.RemoteAddr = "127.0.0.1:4000"
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func createProfileForTest(t *testing.T, nickname string, roles []string) familyProfile {
	t.Helper()
	w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": familyProfile{Nickname: nickname, Roles: roles, AllLibraries: true, AllGames: true}, "pin": "2468", "confirmPIN": "2468"}, nil)
	if w.Code != 200 {
		t.Fatalf("create profile: %d %s", w.Code, w.Body.String())
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range db.Profiles {
		if p.Nickname == nickname {
			return p
		}
	}
	t.Fatal("profile missing")
	return familyProfile{}
}
func profileLoginTest(t *testing.T, id string, extra *http.Cookie) *http.Cookie {
	t.Helper()
	w := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": id, "pin": "2468"}, extra)
	if w.Code != 200 {
		t.Fatalf("profile login: %d %s", w.Code, w.Body.String())
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == "gameshelf-profile" {
			return c
		}
	}
	t.Fatal("profile cookie missing")
	return nil
}
func enableProfilesForTest(t *testing.T) {
	t.Helper()
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	if err != nil {
		t.Fatal(err)
	}
	copy := cloneProfileDB(db)
	copy.Enabled = true
	if err := saveProfileDBLocked(copy, true); err != nil {
		t.Fatal(err)
	}
	setupRequired.Store(false)
}

func TestFamilyProfilesLoginIsolationRevocationAndSecretRedaction(t *testing.T) {
	setupFreshServer(t)
	profileAttempts = map[string]pinBudget{}
	first := createProfileForTest(t, "First", []string{"adult"})
	second := createProfileForTest(t, "Second", []string{"child"})
	if first.Salt == second.Salt || first.Hash == second.Hash {
		t.Fatal("profile verifiers reused")
	}
	if len(first.Salt) < 20 || first.Hash == "2468" {
		t.Fatal("weak verifier")
	}
	guardian := familyCreate(t, nil)
	familyUnlock(t, "7392", []string{"admin"}, guardian)
	enableProfilesForTest(t)
	firstCookie := profileLoginTest(t, first.ID, guardian)
	if hasPINGrant(func() *http.Request { r := httptest.NewRequest("GET", "/", nil); r.AddCookie(guardian); return r }(), "admin") {
		t.Fatal("Guardian unlock survived identity switch")
	}
	public := familyCall(t, handleProfiles, "GET", "/api/profiles", nil, firstCookie).Body.String()
	for _, secret := range []string{first.Salt, first.Hash, second.Salt, second.Hash, "2468"} {
		if strings.Contains(public, secret) {
			t.Fatal("private profile verifier exposed")
		}
	}
	if !strings.Contains(public, "First") {
		t.Fatal(public)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(firstCookie)
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	p, ok := currentProfileLocked(r, db)
	profileMu.Unlock()
	if !ok || p.ID != first.ID {
		t.Fatal("wrong profile session")
	}
	profileMu.Lock()
	copy := cloneProfileDB(db)
	role := copy.Roles["adult"]
	role.Rules["downloads"] = accessRule{Mode: "disable"}
	copy.Roles[role.ID] = role
	if err := saveProfileDBLocked(copy, true); err != nil {
		t.Fatal(err)
	}
	_, ok = currentProfileLocked(r, copy)
	profileMu.Unlock()
	if ok {
		t.Fatal("permissions update did not revoke session")
	}
	w := profileTestCall(t, profileGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })), "GET", "/api/games", nil, []*http.Cookie{firstCookie}, nil)
	if w.Code != 401 {
		t.Fatal("revoked profile still allowed", w.Code)
	}
}

func TestFamilyProfilesCatalogDirectRoutesAndPersonalState(t *testing.T) {
	root, _ := setupFreshServer(t)
	profileAttempts = map[string]pinBudget{}
	p := createProfileForTest(t, "Only one game", []string{"adult"})
	gamesMu.Lock()
	gamesMap = map[string]*gameEntry{"allowed": {Game: Game{ID: "allowed", Name: "Allowed"}, RootDir: root}, "hidden": {Game: Game{ID: "hidden", Name: "Hidden"}, RootDir: root}, "foreign": {Game: Game{ID: "foreign", Name: "Other library"}, RootDir: filepath.Join(root, "other")}}
	gamesMu.Unlock()
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	p.AllLibraries = false
	p.Libraries = []string{localLibraryID(root)}
	p.AllGames = false
	p.Games = []string{"allowed", "foreign"}
	copy.Profiles[p.ID] = p
	saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	enableProfilesForTest(t)
	cookie := profileLoginTest(t, p.ID, nil)
	var seen *profileContext
	handler := profileGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen = profileView(r); w.WriteHeader(204) }))
	for _, path := range []string{"/covers/hidden", "/covers/foreign", "/download/hidden", "/api/game-files/hidden", "/api/game-file/hidden?path=cover.png", "/api/covers/hidden", "/api/cover-source/hidden", "/api/cover-fit/hidden", "/api/game-title/hidden", "/api/favorite/hidden", "/api/metadata-reset/hidden", "/download-playlist?game=allowed&game=hidden", "/download-cart?game=hidden"} {
		w := profileTestCall(t, handler, "GET", path, nil, []*http.Cookie{cookie}, nil)
		if w.Code != 404 {
			t.Errorf("hidden route %s = %d", path, w.Code)
		}
	}
	if w := profileTestCall(t, handler, "GET", "/covers/allowed", nil, []*http.Cookie{cookie}, nil); w.Code != 204 || seen == nil {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest("PUT", "/api/favorite/allowed", nil).WithContext(context.WithValue(context.Background(), profileContextKey{}, seen))
	w := httptest.NewRecorder()
	if !saveProfileFavorite(w, r, "allowed", true) || w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if err := saveProfilePreferences(r, map[string]string{"theme": "midnight", "dynamic-scale": "false"}); err != nil {
		t.Fatal(err)
	}
	profileMu.Lock()
	db, _ = readProfileDBLocked()
	saved := db.Profiles[p.ID]
	profileMu.Unlock()
	if !saved.Favorites["allowed"] || saved.Preferences["theme"] != "midnight" {
		t.Fatal("personal state not saved")
	}
	gamesMu.RLock()
	if gamesMap["allowed"].Game.Favorite {
		t.Fatal("personal favorite changed global game")
	}
	gamesMu.RUnlock()
	value := serverSettings{RootDir: root, RootDirs: []string{root}, DataDir: "private", Sources: []networkSource{{ID: "secret"}}}
	safe := profileSafeSettings(r, value)
	if safe.RootDir != "" || safe.DataDir != "" || len(safe.Sources) > 0 {
		t.Fatal("limited profile leaked locations")
	}
	w = profileTestCall(t, handler, "GET", "/api/source-status", nil, []*http.Cookie{cookie}, nil)
	if strings.Contains(w.Body.String(), "secret") {
		t.Fatal("status leaked hidden sources")
	}
	if w := profileTestCall(t, profileGate(accessGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))), "GET", "/api/health", nil, []*http.Cookie{cookie}, nil); w.Code != 428 {
		t.Fatal("limited profile bypassed manager protection", w.Code)
	}
}

func TestFamilyProfileRolesMostRestrictiveAndFailClosedStorage(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Combined", []string{"administrator", "child"})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	rules := mergedProfileRules(db, p)
	profileMu.Unlock()
	if rules["settings"].Mode != "disable" {
		t.Fatal("less restrictive role won")
	}
	r := httptest.NewRequest("GET", "/", nil).WithContext(context.WithValue(context.Background(), profileContextKey{}, &profileContext{Profile: p, Rules: rules, Epoch: 1}))
	policy := combinedAccessPolicy(r, &accessPolicy{Rules: map[string]accessRule{"downloads": {Mode: "pin"}}})
	if policyMode(policy, "downloads") != "pin" || policyMode(policy, "settings") != "disable" {
		t.Fatal("global restrictions lost")
	}
	if err := os.WriteFile(profilePath(), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	w := profileTestCall(t, profileGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Fatal("corrupt data reached handler") })), "GET", "/api/games", nil, nil, nil)
	if w.Code != 503 {
		t.Fatal("corrupt profiles did not fail closed", w.Code)
	}
}

func TestFamilyProfilesRateLimitAndLogout(t *testing.T) {
	setupFreshServer(t)
	profileAttempts = map[string]pinBudget{}
	p := createProfileForTest(t, "Rate test", []string{"administrator"})
	cookie := profileLoginTest(t, p.ID, nil)
	if r := familyCall(t, handleProfileLogout, "POST", "/api/profiles/logout", nil, cookie); r.Code != 204 {
		t.Fatal(r.Code)
	}
	profileMu.Lock()
	if _, ok := profileSessions[cookie.Value]; ok {
		t.Fatal("logout session remains")
	}
	profileMu.Unlock()
	profileAttempts = map[string]pinBudget{}
	for i := 0; i < 10; i++ {
		r := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "0000"}, nil)
		if r.Code != 401 {
			t.Fatal(i, r.Code)
		}
	}
	if r := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "2468"}, nil); r.Code != 429 {
		t.Fatal("correct PIN bypassed throttle", r.Code)
	}
}

func TestFamilyProfilesEncryptedBackupRoundTripTamperingAndZIP(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Portable", []string{"child"})
	key := base64.StdEncoding.EncodeToString([]byte("a separate backup passphrase"))
	data, err := encodeProfilesBackup(key)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{p.Nickname, p.Hash, p.Salt, "2468"} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatal("plaintext family backup secret")
		}
	}
	db, err := decodeProfilesBackup(data, key)
	if err != nil || db.Profiles[p.ID].Hash != p.Hash {
		t.Fatal("backup round trip", err)
	}
	if _, err := decodeProfilesBackup(data, base64.StdEncoding.EncodeToString([]byte("different long passphrase"))); err == nil {
		t.Fatal("wrong key accepted")
	}
	var envelope protectedProfiles
	json.Unmarshal(data, &envelope)
	sealed, _ := base64.StdEncoding.DecodeString(envelope.Data)
	sealed[0] ^= 1
	envelope.Data = base64.StdEncoding.EncodeToString(sealed)
	tampered, _ := json.Marshal(envelope)
	if _, err := decodeProfilesBackup(tampered, key); err == nil {
		t.Fatal("tampered data accepted")
	}
	if _, err := encodeProfilesBackup(base64.StdEncoding.EncodeToString([]byte("short"))); err == nil {
		t.Fatal("weak backup key accepted")
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/library-backup?select=1&profiles=1", nil)
	r.Header.Set("X-GameShelf-Backup-Key", key)
	handleLibraryBackup(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	z, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range z.File {
		if f.Name == "family-profiles.enc.json" {
			found = true
			file, _ := f.Open()
			contents, _ := io.ReadAll(file)
			file.Close()
			if _, err := decodeProfilesBackup(contents, key); err != nil {
				t.Fatal(err)
			}
		}
		if strings.Contains(f.Name, "pin") {
			t.Fatal("Guardian PIN was exported")
		}
	}
	if !found {
		t.Fatal("profile entry missing from ZIP")
	}
}

func TestFamilyMenuLeaseAvoidsRepeatedSettingsPINButPreservesActionRestrictions(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"settings": {Mode: "pin"}, "advanced": {Mode: "pin"}, "favoriteRemove": {Mode: "pin"}})
	unlocked := familyCall(t, handleAccessUnlock, "POST", "/api/access/unlock", map[string]any{"pin": "7392", "actions": []string{"settings", "advanced"}, "remember": false}, cookie)
	var permit struct{ Token string }
	json.Unmarshal(unlocked.Body.Bytes(), &permit)
	entered := profileTestCall(t, http.HandlerFunc(handleAccessEnter), "POST", "/api/access/enter", map[string]string{"action": "settings", "level": "advanced"}, []*http.Cookie{cookie}, map[string]string{"X-GameShelf-PIN": permit.Token})
	if entered.Code != 200 {
		t.Fatal(entered.Code, entered.Body.String())
	}
	var lease struct {
		Lease string
		Gates map[string]bool
	}
	json.Unmarshal(entered.Body.Bytes(), &lease)
	if !lease.Gates["settings"] || !lease.Gates["advanced"] {
		t.Fatal("settings did not gather both gates")
	}
	headers := map[string]string{"X-GameShelf-Menu": lease.Lease}
	gate := accessGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	if w := profileTestCall(t, gate, "PUT", "/api/settings-events", map[string]string{"theme": "dark"}, []*http.Cookie{cookie}, headers); w.Code != 204 {
		t.Fatal("open settings prompted on save", w.Code, w.Body.String())
	}
	if w := profileTestCall(t, gate, "PUT", "/api/favorite/game", map[string]bool{"favorite": false}, []*http.Cookie{cookie}, headers); w.Code != 423 {
		t.Fatal("menu bypassed independent action", w.Code)
	}
	if w := profileTestCall(t, gate, "PUT", "/api/settings-events", map[string]string{"theme": "dark"}, nil, headers); w.Code != 423 {
		t.Fatal("lease leaked between browsers", w.Code)
	}
	profileTestCall(t, http.HandlerFunc(handleAccessLeave), "POST", "/api/access/leave", map[string]string{"scope": "settings"}, []*http.Cookie{cookie}, headers)
	if w := profileTestCall(t, gate, "PUT", "/api/settings-events", map[string]string{"theme": "dark"}, []*http.Cookie{cookie}, headers); w.Code != 423 {
		t.Fatal("closed menu lease survived", w.Code)
	}
	accessMu.Lock()
	accessSessions[cookie.Value].Expires = time.Now().Add(-time.Second)
	accessMu.Unlock()
}

func TestFamilyProfilesRestoreRequiresKeyAndFreshImportDoesNotEnableAuthority(t *testing.T) {
	setupFreshServer(t)
	profileAttempts = map[string]pinBudget{}
	p := createProfileForTest(t, "Exported", []string{"administrator"})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	copy.Enabled = true
	saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	key := base64.StdEncoding.EncodeToString([]byte("long family backup passphrase"))
	exported := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/api/library-backup?select=1&profiles=1", nil)
	request.Header.Set("X-GameShelf-Backup-Key", key)
	handleLibraryBackup(exported, request)
	if exported.Code != 200 {
		t.Fatal(exported.Code, exported.Body.String())
	}
	archive := exported.Body.Bytes()
	digest := fmt.Sprintf("%x", sha256.Sum256(archive))
	before, _ := os.ReadFile(profilePath())
	restore := func(secret string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/library-restore?apply=1&profiles=1", bytes.NewReader(archive))
		r.Header.Set("X-Preview-SHA256", digest)
		r.Header.Set("X-GameShelf-Backup-Key", secret)
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handleLibraryRestore(w, r)
		return w
	}
	if result := restore(base64.StdEncoding.EncodeToString([]byte("this is the wrong passphrase")), nil); result.Code != 400 {
		t.Fatal(result.Code, result.Body.String())
	}
	after, _ := os.ReadFile(profilePath())
	if !bytes.Equal(before, after) {
		t.Fatal("failed restore modified data")
	}
	if result := restore(key, nil); result.Code != 200 {
		t.Fatal(result.Code, result.Body.String())
	}
	profileMu.Lock()
	db, err := readProfileDBLocked()
	profileMu.Unlock()
	if err != nil || db.Enabled || db.Profiles[p.ID].Hash != p.Hash {
		t.Fatal("fresh import activated authority or lost verifier", err)
	}
	if record, _ := readPINRecord(); record != nil {
		t.Fatal("Guardian authority imported")
	}
	guardian := familyCreate(t, nil)
	if result := restore(key, nil); result.Code != 423 {
		t.Fatal("existing server restore did not require Guardian", result.Code)
	}
	familyUnlock(t, "7392", []string{"admin"}, guardian)
	if result := restore(key, guardian); result.Code != 200 {
		t.Fatal(result.Code, result.Body.String())
	}
	record, err := readPINRecord()
	if err != nil || record == nil {
		t.Fatal("existing Guardian record removed")
	}
	if result := familyUnlock(t, "7392", []string{"admin"}, guardian); result.Code != 200 {
		t.Fatal("existing PIN replaced")
	}
}

func TestFamilyProfileConfigurationShowsFullSnapshotOnlyAfterGuardianApproval(t *testing.T) {
	root, _ := setupFreshServer(t)
	cookie := familyCreate(t, nil)
	profile := familyProfile{ID: "test", AllLibraries: false, AllGames: true, Preferences: map[string]string{"theme": "rose"}}
	view := &profileContext{Profile: profile, Rules: map[string]accessRule{"logging": {Mode: "pin"}}}
	r := httptest.NewRequest("GET", "/api/server-settings", nil).WithContext(context.WithValue(context.Background(), profileContextKey{}, view))
	r.AddCookie(cookie)
	settings := serverSettings{RootDir: root, RootDirs: []string{root}, DataDir: "private-data", Preferences: map[string]string{"theme": "classic"}}
	if safe := profileSafeSettings(r, settings); safe.RootDir != "" {
		t.Fatal("restricted snapshot leaked without approval")
	}
	familyUnlock(t, "7392", []string{"logging"}, cookie)
	if safe := profileSafeSettings(r, settings); safe.RootDir != root || safe.DataDir != "private-data" || safe.Preferences["theme"] != "classic" {
		t.Fatal("approved configuration received incomplete settings")
	}
	accessMu.Lock()
	delete(accessSessions[cookie.Value].Grants, "logging")
	accessMu.Unlock()
	if safe := profileSafeSettings(r, settings); safe.RootDir != "" {
		t.Fatal("expired configuration approval leaked snapshot")
	}
}
