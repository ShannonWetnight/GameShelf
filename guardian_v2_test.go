package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func cookieNamed(t *testing.T, w *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == name && c.MaxAge >= 0 {
			return c
		}
	}
	t.Fatal("missing cookie", name)
	return nil
}
func secondGuardianForTest(t *testing.T, c *http.Cookie) *http.Cookie {
	t.Helper()
	familyUnlock(t, "7392", []string{"admin"}, c)
	w := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "8642", "guardianID": "guardian-2", "policy": accessPolicy{}}, c)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	fresh := familyCall(t, handleAccess, "GET", "/api/access", nil, nil)
	return cookieNamed(t, fresh, "gameshelf-family")
}
func TestTwoGuardiansUniqueAssociationsAndProfileBoundApproval(t *testing.T) {
	setupFreshServer(t)
	c := familyCreate(t, nil)
	c = secondGuardianForTest(t, c)
	familyUnlock(t, "7392", []string{"admin"}, c)
	p := familyProfile{Nickname: "First Guardian", Roles: []string{"administrator"}, UsesGuardianPIN: true, GuardianID: "guardian-1", AllLibraries: true, AllGames: true}
	w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": p}, c)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	p.Nickname = "Duplicate"
	if w := familyCall(t, handleProfiles, "POST", "/api/profiles", map[string]any{"operation": "profile", "profile": p}, c); w.Code != 400 {
		t.Fatal("duplicate association accepted", w.Code)
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	for _, v := range db.Profiles {
		p = v
	}
	profileMu.Unlock()
	enableProfilesForTest(t)
	login := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "7392"}, nil)
	pc := cookieNamed(t, login, "gameshelf-profile")
	gate := profileGate(http.HandlerFunc(handleAccessUnlock))
	for _, entry := range []struct {
		pin  string
		want int
	}{{"8642", 401}, {"7392", 200}} {
		w := profileTestCall(t, gate, "POST", "/api/access/unlock", map[string]any{"pin": entry.pin, "actions": []string{"theme"}}, []*http.Cookie{pc, c}, nil)
		if w.Code != entry.want {
			t.Fatal(entry.pin, w.Code, w.Body.String())
		}
	}
	shared := familyCall(t, handleAccessUnlock, "POST", "/api/access/unlock", map[string]any{"pin": "8642", "actions": []string{"theme"}}, c)
	if shared.Code != 200 {
		t.Fatal("second Guardian cannot approve shared shelf", shared.Code)
	}
	record, _ := readPINRecord()
	if err := setGuardianCredential(record, "guardian-2", "7392"); err == nil {
		t.Fatal("duplicate Guardian PIN accepted")
	}
	if err := setGuardianCredential(record, "guardian-3", "1234"); err == nil {
		t.Fatal("third credential accepted")
	}
}
func TestInitialGuardianCreationIssuesMenuLeaseWithoutAutoProfile(t *testing.T) {
	setupFreshServer(t)
	w := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "7392", "policy": accessPolicy{}}, nil)
	c := cookieNamed(t, w, "gameshelf-family")
	var v struct{ Lease string }
	json.Unmarshal(w.Body.Bytes(), &v)
	if v.Lease == "" {
		t.Fatal("initial approval absent", w.Body.String())
	}
	got := profileTestCall(t, http.HandlerFunc(handleProfiles), "GET", "/api/profiles?manage=1", nil, []*http.Cookie{c}, map[string]string{"X-GameShelf-Menu": v.Lease})
	if got.Code != 200 {
		t.Fatal("creation asked again", got.Code, got.Body.String())
	}
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	count := len(db.Profiles)
	profileMu.Unlock()
	if count != 0 {
		t.Fatal("Guardian created without consent")
	}
	if err := autoGuardianProfile("guardian-1"); err != nil {
		t.Fatal(err)
	}
	profileMu.Lock()
	db, _ = readProfileDBLocked()
	count = len(db.Profiles)
	profileMu.Unlock()
	if count != 1 {
		t.Fatal("opt-in profile missing")
	}
}
func TestSelfEditorScopeAndForcedPINChange(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Personal", []string{"child"})
	profileMu.Lock()
	db, _ := readProfileDBLocked()
	copy := cloneProfileDB(db)
	p.ForcePINChange = true
	copy.Profiles[p.ID] = p
	saveProfileDBLocked(copy, true)
	profileMu.Unlock()
	login := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "2468"}, nil)
	if !strings.Contains(login.Body.String(), "changeRequired") {
		t.Fatal(login.Body.String())
	}
	for _, c := range login.Result().Cookies() {
		if c.Name == "gameshelf-profile" && c.MaxAge > 0 {
			t.Fatal("full login issued before PIN change")
		}
	}
	edit := cookieNamed(t, login, "gameshelf-profile-edit")
	headers := []*http.Cookie{edit}
	bad := profileTestCall(t, http.HandlerFunc(handleProfileSelf), "PUT", "/api/profiles/self", map[string]any{"newPIN": "1357", "confirmPIN": "1357", "roles": []string{"administrator"}}, headers, nil)
	if bad.Code != 400 {
		t.Fatal("self edit accepted permission fields", bad.Code)
	}
	bad = profileTestCall(t, http.HandlerFunc(handleProfileSelf), "PUT", "/api/profiles/self", map[string]string{"newPIN": "2468", "confirmPIN": "2468"}, headers, nil)
	if bad.Code != 400 {
		t.Fatal("forced change accepted old PIN")
	}
	good := profileTestCall(t, http.HandlerFunc(handleProfileSelf), "PUT", "/api/profiles/self", map[string]string{"newPIN": "1357", "confirmPIN": "1357"}, headers, nil)
	if good.Code != 200 {
		t.Fatal(good.Code, good.Body.String())
	}
	if w := profileTestCall(t, http.HandlerFunc(handleProfileSelf), "GET", "/api/profiles/self", nil, headers, nil); w.Code != 401 {
		t.Fatal("editor token replay accepted")
	}
	newLogin := familyCall(t, handleProfileLogin, "POST", "/api/profiles/login", map[string]string{"id": p.ID, "pin": "1357"}, nil)
	if newLogin.Code != 200 || strings.Contains(newLogin.Body.String(), "changeRequired") {
		t.Fatal("PIN change did not finish", newLogin.Body.String())
	}
	opened := familyCall(t, handleProfileSelf, "POST", "/api/profiles/self/open", map[string]string{"id": p.ID, "pin": "1357"}, nil)
	token := cookieNamed(t, opened, "gameshelf-profile-edit")
	changed := profileTestCall(t, http.HandlerFunc(handleProfileSelf), "PUT", "/api/profiles/self", map[string]string{"nickname": "New Name", "avatar": "builtin:moonlit-knight"}, []*http.Cookie{token}, nil)
	if changed.Code != 200 {
		t.Fatal(changed.Code, changed.Body.String())
	}
	profileMu.Lock()
	db, _ = readProfileDBLocked()
	got := db.Profiles[p.ID]
	profileMu.Unlock()
	if got.Nickname != "New Name" || len(got.Roles) != 1 || got.Roles[0] != "child" {
		t.Fatal("self edit altered roles")
	}
}
func TestOptionalProfileBackupRequiresExplicitConsentAndRoundTrips(t *testing.T) {
	setupFreshServer(t)
	p := createProfileForTest(t, "Backup", []string{"child"})
	familyCreate(t, nil)
	w := familyCall(t, handleLibraryBackup, "GET", "/api/library-backup?select=1&profiles=1", nil, nil)
	if w.Code != 400 {
		t.Fatal("blank export lacked consent", w.Code)
	}
	w = familyCall(t, handleLibraryBackup, "GET", "/api/library-backup?select=1&profiles=1&unprotected=1", nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	plain, err := encodeProfilesBackup("")
	if err != nil {
		t.Fatal(err)
	}
	db, err := decodeProfilesBackup(plain, "")
	if err != nil || db.Profiles[p.ID].Hash != p.Hash {
		t.Fatal("plain restore", err)
	}
	record, _ := readPINRecord()
	if bytes.Contains(plain, []byte(record.Hash)) || bytes.Contains(plain, []byte(record.Salt)) {
		t.Fatal("Guardian verifier exported")
	}
	eight := base64.StdEncoding.EncodeToString([]byte("12345678"))
	encrypted, err := encodeProfilesBackup(eight)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = decodeProfilesBackup(encrypted, eight); err != nil {
		t.Fatal(err)
	}
	if _, err = profileBackupKey(base64.StdEncoding.EncodeToString([]byte("1234567"))); err == nil {
		t.Fatal("short passphrase accepted")
	}
}
func TestWipeMenuApprovalIsScopedAndOptionalOnUnprotectedShelf(t *testing.T) {
	setupFreshServer(t)
	w := familyCall(t, handleResetServerSettings, "POST", "/api/server-settings/reset", map[string]any{"confirm": "Game Over", "acknowledgeBackup": true}, nil)
	if w.Code != 200 {
		t.Fatal("unprotected wipe required PIN", w.Code, w.Body.String())
	}
	c := familyCreate(t, nil)
	policy, _, _ := currentAccessPolicy()
	token, _ := onePIN(t, c, accessDependencies(policy, resetAccessActions(), true), false)
	entered := profileTestCall(t, http.HandlerFunc(handleAccessEnter), "POST", "/api/access/enter", map[string]string{"action": "wipe"}, []*http.Cookie{c}, map[string]string{"X-GameShelf-PIN": token})
	if entered.Code != 200 {
		t.Fatal(entered.Code, entered.Body.String())
	}
	var v struct{ Lease string }
	json.Unmarshal(entered.Body.Bytes(), &v)
	headers := map[string]string{"X-GameShelf-Menu": v.Lease}
	admin := profileTestCall(t, http.HandlerFunc(handleProfiles), "GET", "/api/profiles?manage=1", nil, []*http.Cookie{c}, headers)
	if admin.Code != 423 {
		t.Fatal("wipe lease escaped into profiles", admin.Code)
	}
	w = profileTestCall(t, http.HandlerFunc(handleResetServerSettings), "POST", "/api/server-settings/reset", map[string]any{"confirm": "Game Over", "acknowledgeBackup": true}, []*http.Cookie{c}, headers)
	if w.Code != 200 {
		t.Fatal("second prompt on confirmed wipe", w.Code, w.Body.String())
	}
}
func TestSetupDraftCatalogRemainsGatedAndCompletedFlagWins(t *testing.T) {
	root, data := setupFreshServer(t)
	os.Mkdir(filepath.Join(root, "Draft Game"), 0755)
	value := serverSettings{RootDir: root, RootDirs: []string{root}, DataDir: data, RefreshInterval: "168h"}
	w := familyCall(t, handleSetup, "POST", "/api/setup?draft=1", value, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if !setupRequired.Load() || configuredSettings.SetupCompleted {
		t.Fatal("staging exposed shelf")
	}
	if len(profileLibraries()) != 1 {
		t.Fatal("staged library missing")
	}
	catalog := familyCall(t, handleProfileCatalog, "GET", "/api/profiles/catalog", nil, nil)
	if catalog.Code != 200 || !strings.Contains(catalog.Body.String(), "Draft Game") {
		t.Fatal("staged game missing", catalog.Code, catalog.Body.String())
	}
	w = familyCall(t, handleSetup, "POST", "/api/setup", value, nil)
	if w.Code != 200 || setupRequired.Load() {
		t.Fatal("setup not completed", w.Code)
	}
	completed := configuredSettings
	completed.SetupStatus = "pending"
	if needsFirstSetup(completed) {
		t.Fatal("completed setup reappeared")
	}
}
