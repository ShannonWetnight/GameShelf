package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func familyCall(t *testing.T, handler http.HandlerFunc, method, path string, value any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	if value != nil {
		if err := json.NewEncoder(&body).Encode(value); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, &body)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}
func familyCreate(t *testing.T, rules map[string]accessRule) *http.Cookie {
	t.Helper()
	result := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "7392", "policy": accessPolicy{Rules: rules}}, nil)
	if result.Code != 200 {
		t.Fatalf("create: %d %s", result.Code, result.Body.String())
	}
	return result.Result().Cookies()[0]
}
func familyUnlock(t *testing.T, pin string, actions []string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	return familyCall(t, handleAccessUnlock, "POST", "/api/access/unlock", map[string]any{"pin": pin, "actions": actions, "remember": true}, cookie)
}
func familyGate(t *testing.T, path, method string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var data bytes.Buffer
	if body != nil {
		json.NewEncoder(&data).Encode(body)
	}
	request := httptest.NewRequest(method, path, &data)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	accessGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(response, request)
	return response
}
func TestFamilyPINScopesDisableIsolationAndSecrets(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"favoriteRemove": {"pin", false, ""}, "covers": {"disable", false, ""}, "theme": {"pin", true, ""}, "health": {"disable", false, ""}})
	for _, path := range []string{"/api/favorite/game", "/api/covers/game", "/api/cover-fit/game"} {
		r := familyGate(t, path, "PUT", map[string]bool{"favorite": false}, nil)
		if r.Code != 423 && r.Code != 403 {
			t.Fatalf("unguarded %s: %d", path, r.Code)
		}
	}
	if r := familyUnlock(t, "0000", []string{"favoriteRemove"}, cookie); r.Code != 401 {
		t.Fatal(r.Code)
	}
	if r := familyUnlock(t, "7392", []string{"favoriteRemove"}, cookie); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := familyGate(t, "/api/favorite/game", "PUT", map[string]bool{"favorite": false}, cookie); r.Code != 204 {
		t.Fatal(r.Code)
	}
	if r := familyGate(t, "/api/favorite/game", "PUT", map[string]bool{"favorite": false}, nil); r.Code != 423 {
		t.Fatal("grant leaked to another browser", r.Code)
	}
	familyUnlock(t, "7392", []string{"covers"}, cookie)
	if r := familyGate(t, "/api/covers/game", "PUT", nil, cookie); r.Code != 403 {
		t.Fatal("PIN bypassed Disable", r.Code)
	}
	settingsMu.RLock()
	value := configuredSettings
	settingsMu.RUnlock()
	value.Health = &healthOptions{true, 60}
	if r := familyGate(t, "/api/server-settings", "PUT", value, cookie); r.Code != 403 {
		t.Fatal("health config used viewing policy", r.Code)
	}
	accessMu.Lock()
	accessSessions[cookie.Value].Grants["favoriteRemove"] = time.Now().Add(-time.Second)
	accessMu.Unlock()
	if r := familyGate(t, "/api/favorite/game", "PUT", map[string]bool{"favorite": false}, cookie); r.Code != 423 {
		t.Fatal("expired grant accepted", r.Code)
	}
	public := familyCall(t, handleAccess, "GET", "/api/access", nil, cookie).Body.String()
	record, err := readPINRecord()
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := json.Marshal(publicSettings(value))
	for _, secret := range []string{"7392", record.Hash, record.Salt} {
		if strings.Contains(public, secret) || strings.Contains(string(settings), secret) {
			t.Fatal("secret exposed")
		}
	}
	if r := familyCall(t, handleAccess, "DELETE", "/api/access", nil, nil); r.Code != 423 {
		t.Fatal("unprotected PIN removal", r.Code)
	}
	familyUnlock(t, "7392", []string{"admin"}, cookie)
	if r := familyCall(t, handleAccess, "DELETE", "/api/access", nil, cookie); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if record, _ := readPINRecord(); record != nil {
		t.Fatal("PIN not removed")
	}
}
func TestFamilyPreventsResetRestoreAndPreferenceDeletionBypass(t *testing.T) {
	setupFreshServer(t)
	settingsMu.Lock()
	configuredSettings.Preferences = map[string]string{"theme": "dark", "settings-level": "basic"}
	settingsMu.Unlock()
	cookie := familyCreate(t, map[string]accessRule{"theme": {"pin", false, ""}, "sources": {"pin", false, ""}, "favoriteRemove": {"disable", false, ""}})
	settingsMu.RLock()
	value := configuredSettings
	settingsMu.RUnlock()
	value.Preferences = map[string]string{}
	if r := familyGate(t, "/api/server-settings", "PUT", value, cookie); r.Code != 423 {
		t.Fatal("protected preference deletion escaped", r.Code)
	}
	for _, path := range []string{"/api/server-settings/reset", "/api/library-restore?apply=1&settings=1", "/api/library-restore?apply=1&state=1"} {
		if r := familyGate(t, path, "POST", nil, cookie); r.Code == 204 {
			t.Fatal("restore/reset bypass", path)
		}
	}
	// Ordinary PUT and Wipe must not replace the authoritative private policy.
	value.Preferences = nil
	value.Access = &accessPolicy{Rules: map[string]accessRule{}}
	if r := familyCall(t, handleServerSettings, "PUT", "/api/server-settings", value, cookie); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	policy, configured, err := currentAccessPolicy()
	if err != nil || !configured || policyMode(policy, "sources") != "pin" {
		t.Fatal("policy replaced", err)
	}
	if r := familyCall(t, handleResetServerSettings, "POST", "/api/server-settings/reset", nil, cookie); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	policy, configured, err = currentAccessPolicy()
	if err != nil || !configured || policyMode(policy, "favoriteRemove") != "disable" {
		t.Fatal("wipe removed family controls", err)
	}
	// Navigation is never a restriction, so owners can always reach Family Controls.
	if _, exists := accessActions["settingsLevel"]; exists {
		t.Fatal("navigation can lock out the owner")
	}
}
func TestFamilyAttemptLimitsAndCorruptionFailClosed(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"downloads": {"pin", false, ""}})
	for i := 0; i < 6; i++ {
		if r := familyUnlock(t, "0000", []string{"downloads"}, cookie); r.Code != 401 {
			t.Fatal(i, r.Code)
		}
	}
	if r := familyUnlock(t, "7392", []string{"downloads"}, cookie); r.Code != 429 || r.Header().Get("Retry-After") == "" {
		t.Fatal("rate limit absent", r.Code)
	}
	if err := os.WriteFile(pinPath(), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if r := familyGate(t, "/download/game", "GET", nil, cookie); r.Code != 503 {
		t.Fatal("corrupt PIN failed open", r.Code)
	}
	if r := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "1111", "policy": accessPolicy{}}, nil); r.Code != 503 {
		t.Fatal("corrupt PIN overwritten", r.Code)
	}
}
func TestFamilyBackupRulesWithoutSecretsAndFreshRestoreRequiresNewPIN(t *testing.T) {
	setupFreshServer(t)
	familyCreate(t, map[string]accessRule{"wipe": {"pin", false, ""}})
	var backup bytes.Buffer
	if err := writeLibraryBackupWithHealth(&backup, false, true, true, map[string]bool{}, nil, true); err != nil {
		t.Fatal(err)
	}
	archive, err := parseRestoreArchive(backup.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	record, _ := readPINRecord()
	if bytes.Contains(archive.settings, []byte(record.Hash)) || bytes.Contains(archive.settings, []byte(record.Salt)) {
		t.Fatal("PIN secret in backup")
	}
	var saved serverSettings
	json.Unmarshal(archive.settings, &saved)
	if policyMode(saved.Access, "wipe") != "pin" {
		t.Fatal("rules not exported")
	}
	if strings.Contains(string(archive.settings), "family-pin") {
		t.Fatal("private file included")
	}
	if err := os.Remove(filepath.Join(settingsHome, ".family-pin.json")); err != nil {
		t.Fatal(err)
	}
	settingsMu.Lock()
	configuredSettings.Access = saved.Access
	settingsMu.Unlock()
	if r := familyGate(t, "/api/server-settings/reset", "POST", nil, nil); r.Code != 428 {
		t.Fatal("restored policy silently opened", r.Code)
	}
	if r := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "1abc", "policy": saved.Access}, nil); r.Code != 400 {
		t.Fatal("invalid PIN accepted", r.Code)
	}
	familyCreate(t, saved.Access.Rules)
}

func TestFamilyInitialCreationRaceAndPINChangeInvalidateOtherSessions(t *testing.T) {
	setupFreshServer(t)
	var wait sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 2)
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results <- familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "7392", "policy": accessPolicy{Rules: map[string]accessRule{"downloads": {"pin", false, ""}}}}, nil)
		}()
	}
	wait.Wait()
	close(results)
	success, blocked := 0, 0
	var cookie *http.Cookie
	for result := range results {
		if result.Code == 200 {
			success++
			cookie = result.Result().Cookies()[0]
		} else if result.Code == 423 {
			blocked++
		} else {
			t.Fatal(result.Code, result.Body.String())
		}
	}
	if success != 1 || blocked != 1 {
		t.Fatal("initial PIN overwritten by concurrent creation", success, blocked)
	}
	second := familyCall(t, handleAccess, "GET", "/api/access", nil, nil).Result().Cookies()[0]
	familyUnlock(t, "7392", []string{"downloads"}, second)
	familyUnlock(t, "7392", []string{"admin"}, cookie)
	if r := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "6248", "policy": accessPolicy{Rules: map[string]accessRule{"downloads": {"pin", false, ""}}}}, cookie); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := familyGate(t, "/download/game", "GET", nil, second); r.Code != 423 {
		t.Fatal("PIN change kept another browser unlocked", r.Code)
	}
	if r := familyUnlock(t, "7392", []string{"downloads"}, second); r.Code != 401 {
		t.Fatal("old PIN still works", r.Code)
	}
	if r := familyUnlock(t, "6248", []string{"downloads"}, second); r.Code != 200 {
		t.Fatal("new PIN failed", r.Code, r.Body.String())
	}
}
func TestFamilyCSRFAndCorruptStoreCannotChangeRules(t *testing.T) {
	setupFreshServer(t)
	request := httptest.NewRequest("PUT", "http://gameshelf.local/api/access", strings.NewReader(`{"newPin":"7392","policy":{"rules":{}}}`))
	request.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	setupGate(accessGate(http.HandlerFunc(handleAccess))).ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal("cross-origin PIN creation accepted", response.Code)
	}
	if record, _ := readPINRecord(); record != nil {
		t.Fatal("CSRF wrote PIN")
	}
}

func TestFamilyRejectsAmbiguousJSONBeforeAuthorization(t *testing.T) {
	setupFreshServer(t)
	familyCreate(t, map[string]accessRule{"theme": {"disable", false, ""}, "favoriteAdd": {"disable", false, ""}, "titles": {"disable", false, ""}})
	settingsMu.RLock()
	value := configuredSettings
	settingsMu.RUnlock()
	value.Preferences = map[string]string{"theme": "light"}
	settingsBody, _ := json.Marshal(value)
	for _, value := range []struct{ path, body string }{{"/api/server-settings", string(settingsBody) + ` {}`}, {"/api/favorite/game", `{"favorite":true} {}`}, {"/api/metadata-reset/game", `{"title":true} garbage`}, {"/api/settings-events", `{"theme":"light"} {}`}} {
		called := false
		response := httptest.NewRecorder()
		accessGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true })).ServeHTTP(response, httptest.NewRequest("PUT", value.path, strings.NewReader(value.body)))
		if called || response.Code != 400 {
			t.Fatal("ambiguous JSON reached handler", value.path, response.Code)
		}
	}
}
