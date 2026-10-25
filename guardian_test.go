package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGuardianMenuGatesAndCategoryPersistence(t *testing.T) {
	setupFreshServer(t)
	rules := map[string]accessRule{"settings": {"pin", false, ""}, "advanced": {"pin", false, ""}, "libraryManager": {"pin", false, "advanced"}, "theme": {"allow", false, "advanced"}, "admin": {"pin", false, "basic"}}
	cookie := familyCreate(t, rules)
	enter := func(action string) *httptest.ResponseRecorder {
		return familyCall(t, handleAccessEnter, "POST", "/api/access/enter", map[string]string{"action": action}, cookie)
	}
	if r := enter("settings"); r.Code != 423 {
		t.Fatal("Settings gate open", r.Code)
	}
	if r := familyGate(t, "/download/game", "GET", nil, cookie); r.Code != 204 {
		t.Fatal("menu gate blocked ordinary game actions", r.Code)
	}
	if r := familyGate(t, "/api/logs", "GET", nil, cookie); r.Code != 423 {
		t.Fatal("direct settings operation bypassed menu gate", r.Code)
	}
	if r := familyUnlock(t, "7392", []string{"settings"}, cookie); r.Code != 200 {
		t.Fatal(r.Code)
	}
	if r := enter("settings"); r.Code != 204 {
		t.Fatal(r.Code)
	}
	if r := enter("advanced"); r.Code != 423 {
		t.Fatal("Advanced gate open", r.Code)
	}
	familyUnlock(t, "7392", []string{"advanced"}, cookie)
	if r := enter("libraryManager"); r.Code != 423 {
		t.Fatal("Manager gate open", r.Code)
	}
	familyUnlock(t, "7392", []string{"libraryManager"}, cookie)
	if r := familyGate(t, "/api/library-folders", "GET", nil, cookie); r.Code != 204 {
		t.Fatal(r.Code, r.Body.String())
	}
	public := familyCall(t, handleAccess, "GET", "/api/access", nil, cookie)
	var state struct {
		Policy accessPolicy      `json:"policy"`
		Levels map[string]string `json:"levels"`
		Groups map[string]string `json:"groups"`
	}
	json.Unmarshal(public.Body.Bytes(), &state)
	if state.Policy.Rules["theme"].Level != "advanced" || state.Policy.Rules["admin"].Level != "basic" || state.Groups["theme"] != "Appearance" || state.Levels["libraryManager"] != "advanced" {
		t.Fatal("categories missing", state)
	}
	// Moving a control into Advanced carries the tab gate into its API check.
	accessMu.Lock()
	delete(accessSessions[cookie.Value].Grants, "advanced")
	accessMu.Unlock()
	settingsMu.RLock()
	value := configuredSettings
	settingsMu.RUnlock()
	value.Preferences = map[string]string{"theme": "light"}
	if r := familyGate(t, "/api/server-settings", "PUT", value, cookie); r.Code != 423 || !strings.Contains(r.Body.String(), "advanced") {
		t.Fatal("category did not protect direct API", r.Code, r.Body.String())
	}
}
func TestGuardianPINRotationDeauthenticatesEveryBrowser(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"settings": {"pin", false, ""}})
	familyUnlock(t, "7392", []string{"settings", "admin"}, cookie)
	result := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"newPin": "6248", "policy": accessPolicy{Rules: map[string]accessRule{"settings": {"pin", false, ""}}}}, cookie)
	if result.Code != 200 {
		t.Fatal(result.Code, result.Body.String())
	}
	for _, action := range []string{"settings", "admin"} {
		request := httptest.NewRequest("GET", "/api/access", nil)
		request.AddCookie(cookie)
		if hasPINGrant(request, action) {
			t.Fatal("PIN rotation preserved grant", action)
		}
	}
	if r := familyCall(t, handleAccess, "DELETE", "/api/access", nil, cookie); r.Code != 423 {
		t.Fatal("old current browser can manage controls", r.Code)
	}
	if r := familyUnlock(t, "7392", []string{"admin"}, cookie); r.Code != 401 {
		t.Fatal("old PIN still accepted", r.Code)
	}
	if r := familyUnlock(t, "6248", []string{"admin"}, cookie); r.Code != 200 {
		t.Fatal("new PIN not accepted", r.Code)
	}
}
func TestGuardianMenuRulesCannotHideOrDisableRecovery(t *testing.T) {
	for _, action := range []string{"settings", "advanced", "admin"} {
		for _, rule := range []accessRule{{Mode: "disable"}, {Mode: "pin", Hidden: true}, {Mode: "allow", Level: "other"}} {
			if validateAccessPolicy(&accessPolicy{Rules: map[string]accessRule{action: rule}}) == nil {
				t.Fatal("invalid gate/recovery rule accepted", action, rule)
			}
		}
	}
}
func TestManualRefreshRateLimitAndInFlightCoalescing(t *testing.T) {
	root, _ := setupFreshServer(t)
	rootDir, rootDirs = root, []string{root}
	writeGame(t, "Alpha")
	first := httptest.NewRecorder()
	handleGames(first, httptest.NewRequest("GET", "/api/games?forceRefresh=1", nil))
	if first.Code != 200 {
		t.Fatal(first.Code, first.Body.String())
	}
	writeGame(t, "Beta")
	var wait sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 24)
	for i := 0; i < 24; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			r := httptest.NewRecorder()
			handleGames(r, httptest.NewRequest("GET", "/api/games?forceRefresh=1", nil))
			responses <- r
		}()
	}
	wait.Wait()
	close(responses)
	for response := range responses {
		if response.Code != 429 || response.Header().Get("Retry-After") == "" {
			t.Fatal("autoclick refresh escaped", response.Code)
		}
	}
	cached := httptest.NewRecorder()
	handleGames(cached, httptest.NewRequest("GET", "/api/games", nil))
	if bytes.Contains(cached.Body.Bytes(), []byte("Beta")) || !bytes.Contains(cached.Body.Bytes(), []byte("Alpha")) {
		t.Fatal("blocked refresh changed the catalog", cached.Body.String())
	}
	manualRefreshMu.Lock()
	manualRefreshLast = time.Now().Add(-time.Minute)
	manualRefreshActive = true
	manualRefreshMu.Unlock()
	if admitManualRefresh(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/games", nil)) {
		t.Fatal("another refresh queued behind a long discovery")
	}
	finishManualRefresh()
	if !admitManualRefresh(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/games", nil)) {
		t.Fatal("cooldown did not expire")
	}
	finishManualRefresh()
}
func TestHealthLoggingDefaultsMigrateAndCanBeCustomized(t *testing.T) {
	setupFreshServer(t)
	options := normalizeLogOptions(&logOptions{BaseConfigured: true, SizeMB: 10})
	if !options.Health || !options.HealthConfigured {
		t.Fatal("new health category not enabled on upgrade")
	}
	options.Health = false
	settingsMu.Lock()
	configuredSettings.LogOptions = options
	settingsMu.Unlock()
	verboseLogging.Store(false)
	if !logTypeEnabled("health") {
		t.Fatal("default health events missing")
	}
	verboseLogging.Store(true)
	if logTypeEnabled("health") {
		t.Fatal("disabled health category still logs")
	}
}

var _ = http.StatusOK

type pausedCatalogResponse struct {
	header  http.Header
	entered chan struct{}
	release chan struct{}
}

func (w *pausedCatalogResponse) Header() http.Header { return w.header }
func (w *pausedCatalogResponse) WriteHeader(int)     {}
func (w *pausedCatalogResponse) Write(value []byte) (int, error) {
	close(w.entered)
	<-w.release
	return len(value), nil
}
func TestManualDiscoverySlotDoesNotWaitForSlowCatalogReaders(t *testing.T) {
	root, _ := setupFreshServer(t)
	rootDir, rootDirs = root, []string{root}
	writeGame(t, "Alpha")
	writer := &pausedCatalogResponse{header: http.Header{}, entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() { handleGames(writer, httptest.NewRequest("GET", "/api/games?forceRefresh=1", nil)); close(done) }()
	select {
	case <-writer.entered:
	case <-time.After(2 * time.Second):
		close(writer.release)
		t.Fatal("catalog response did not start")
	}
	manualRefreshMu.Lock()
	active := manualRefreshActive
	manualRefreshMu.Unlock()
	close(writer.release)
	<-done
	if active {
		t.Fatal("slow response reader retained the discovery slot")
	}
}
