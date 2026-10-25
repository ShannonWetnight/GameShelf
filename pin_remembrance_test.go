package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func onePIN(t *testing.T, cookie *http.Cookie, actions []string, remember bool) (string, *httptest.ResponseRecorder) {
	t.Helper()
	response := familyCall(t, handleAccessUnlock, "POST", "/api/access/unlock", map[string]any{"pin": "7392", "actions": actions, "remember": remember}, cookie)
	if response.Code != 200 {
		t.Fatalf("unlock: %d %s", response.Code, response.Body.String())
	}
	var result struct{ Token string }
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Token, response
}
func permitRequest(t *testing.T, cookie *http.Cookie, token string, actions []string, twice bool) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest("POST", "/test", nil)
	request.AddCookie(cookie)
	request.Header.Set("X-GameShelf-PIN", token)
	response := httptest.NewRecorder()
	if checkAccess(response, request, actions) {
		if twice && !checkAccess(response, request, actions) {
			t.Error("same request lost its approval")
			return response
		}
		response.WriteHeader(204)
	}
	return response
}
func TestPINRemembranceOneRequestScopeReplayAndConcurrency(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"covers": {"pin", false, ""}, "titles": {"pin", false, ""}})
	token, unlock := onePIN(t, cookie, []string{"covers"}, false)
	check := httptest.NewRequest("GET", "/", nil)
	check.AddCookie(cookie)
	if token == "" || hasPINGrant(check, "covers") {
		t.Fatal("missing one-use authorization")
	}
	for _, c := range unlock.Result().Cookies() {
		if c.Name == "gameshelf-once" && (!c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.MaxAge != 60) {
			t.Fatal("unsafe one-use cookie")
		}
	}
	if r := permitRequest(t, cookie, token, []string{"titles"}, false); r.Code != 423 {
		t.Fatal("permit escaped its action scope")
	}
	if r := permitRequest(t, cookie, token, []string{"covers"}, true); r.Code != 204 || r.Header().Get("X-GameShelf-PIN-Consumed") != "true" {
		t.Fatal("permit was not consumed by the whole request")
	}
	if r := permitRequest(t, cookie, token, []string{"covers"}, false); r.Code != 423 {
		t.Fatal("permit replay accepted")
	}
	token, _ = onePIN(t, cookie, []string{"covers"}, false)
	var wg sync.WaitGroup
	results := make(chan int, 12)
	for range 12 {
		wg.Add(1)
		go func() { defer wg.Done(); results <- permitRequest(t, cookie, token, []string{"covers"}, true).Code }()
	}
	wg.Wait()
	close(results)
	accepted := 0
	for code := range results {
		if code == 204 {
			accepted++
		} else if code != 423 {
			t.Fatal(code)
		}
	}
	if accepted != 1 {
		t.Fatalf("%d concurrent replays accepted", accepted)
	}
}
func TestPINRemembranceLimitsDisabledAndPersisted(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"covers": {"pin", false, ""}})
	if options := remembrance(nil); !options.Enabled || options.Minutes != 5 {
		t.Fatal("wrong migration defaults")
	}
	familyUnlock(t, "7392", []string{"admin"}, cookie)
	for _, minutes := range []int{-1, 0, 61} {
		response := familyCall(t, handleAccess, "PUT", "/api/access", map[string]any{"policy": accessPolicy{Rules: map[string]accessRule{}, Remember: &pinRemembrance{true, minutes}}}, cookie)
		if response.Code != 400 {
			t.Fatalf("accepted duration %d: %d", minutes, response.Code)
		}
	}
	for _, enabled := range []bool{false, true} {
		token, _ := onePIN(t, cookie, []string{"admin"}, true)
		response := familyCall(t, func(w http.ResponseWriter, r *http.Request) {
			r.Header.Set("X-GameShelf-PIN", token)
			handleAccess(w, r)
		}, "PUT", "/api/access", map[string]any{"policy": accessPolicy{Rules: map[string]accessRule{"covers": {"pin", false, ""}}, Remember: &pinRemembrance{enabled, 60}}}, cookie)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		record, err := readPINRecord()
		if err != nil || record.Remember == nil || record.Remember.Enabled != enabled {
			t.Fatal("remembrance not persisted")
		}
		token, unlock := onePIN(t, cookie, []string{"covers"}, true)
		var result struct {
			Remembered bool
			ExpiresAt  time.Time
		}
		json.Unmarshal(unlock.Body.Bytes(), &result)
		if enabled {
			if token != "" || !result.Remembered || time.Until(result.ExpiresAt) > 60*time.Minute || time.Until(result.ExpiresAt) < 59*time.Minute {
				t.Fatal("remembered duration not bounded")
			}
		} else {
			if token == "" || result.Remembered {
				t.Fatal("client bypassed disabled remembrance")
			}
		}
	}
}
func TestPINOneRequestAdminSaveAndRevocation(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"covers": {"pin", false, ""}})
	token, _ := onePIN(t, cookie, []string{"admin"}, false)
	body := strings.NewReader("{\"policy\":{\"rules\":{\"covers\":{\"mode\":\"pin\"}},\"remember\":{\"enabled\":false,\"minutes\":5}}}")
	request := httptest.NewRequest("PUT", "/api/access", body)
	request.AddCookie(cookie)
	request.Header.Set("X-GameShelf-PIN", token)
	response := httptest.NewRecorder()
	handleAccess(response, request)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if r := permitRequest(t, cookie, token, []string{"admin"}, false); r.Code != 423 {
		t.Fatal("policy save retained approval")
	}
	token, _ = onePIN(t, cookie, []string{"covers"}, false)
	accessMu.Lock()
	permit := accessSessions[cookie.Value].Permits[token]
	permit.Expires = time.Now().Add(-time.Second)
	accessSessions[cookie.Value].Permits[token] = permit
	accessMu.Unlock()
	if r := permitRequest(t, cookie, token, []string{"covers"}, false); r.Code != 423 {
		t.Fatal("expired permit accepted")
	}
}
func TestNewLoggingAndScaleDefaults(t *testing.T) {
	setupFreshServer(t)
	value := defaultServerSettings()
	options := value.LogOptions
	if !value.Verbose || !options.System || !options.Library || !options.Errors || !options.Health || !options.Requests || !options.Scans || !options.Downloads {
		t.Fatal("new servers must log all sources")
	}
	for _, scale := range []string{"0.75", "1.25", "1.5"} {
		if err := validatePreferences(map[string]string{"ui-scale": scale}); err != nil {
			t.Fatal(err)
		}
	}
	for _, scale := range []string{"0.74", "1.51", "NaN", "Inf"} {
		if validatePreferences(map[string]string{"ui-scale": scale}) == nil {
			t.Fatal("invalid scale accepted")
		}
	}
}

func TestPINOneUseDownloadCookieAndPolicyRevocation(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"downloads": {"pin", false, ""}})
	token, _ := onePIN(t, cookie, []string{"downloads"}, false)
	request := httptest.NewRequest("GET", "/download/game", nil)
	request.AddCookie(cookie)
	request.AddCookie(&http.Cookie{Name: "gameshelf-once", Value: token})
	response := httptest.NewRecorder()
	if !checkAccess(response, request, []string{"downloads"}) {
		t.Fatal("one-use navigation cookie was rejected")
	}
	accessMu.Lock()
	accessSessions[cookie.Value].Epoch++
	accessMu.Unlock()
	if checkAccess(httptest.NewRecorder(), request, []string{"downloads"}) {
		t.Fatal("request approval survived a policy revision")
	}
	replay := httptest.NewRequest("GET", "/download/game", nil)
	replay.AddCookie(cookie)
	replay.AddCookie(&http.Cookie{Name: "gameshelf-once", Value: token})
	if checkAccess(httptest.NewRecorder(), replay, []string{"downloads"}) {
		t.Fatal("navigation cookie was reusable")
	}
}
