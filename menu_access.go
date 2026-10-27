package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"
)

func isMenuScope(action string) bool {
	switch action {
	case "wipe", "settings", "advanced", "admin", "libraryManager", "sources", "storage", "refresh", "logging", "logs", "health", "healthView", "covers", "recentRange", "export", "restore":
		return true
	}
	return false
}

type menuLease struct {
	Scopes map[string]bool
	Until  time.Time
}

func randomKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Called with accessMu held. Only open-menu gates are covered; action restrictions remain independent.
func menuAuthorized(session *pinSession, r *http.Request, action string) bool {
	lease, ok := session.Menus[r.Header.Get("X-GameShelf-Menu")]
	return ok && time.Now().Before(lease.Until) && lease.Scopes[action]
}
func issueMenuLease(w http.ResponseWriter, r *http.Request, actions []string) {
	id := ensurePINSession(w, r)
	if id == "" {
		http.Error(w, "Could not open menu.", 503)
		return
	}
	accessMu.Lock()
	defer accessMu.Unlock()
	session := accessSessions[id]
	if session.Menus == nil {
		session.Menus = map[string]menuLease{}
	}
	token := r.Header.Get("X-GameShelf-Menu")
	lease, ok := session.Menus[token]
	if !ok || time.Now().After(lease.Until) {
		var err error
		token, err = randomKey()
		if err != nil {
			http.Error(w, "Could not open menu.", 503)
			return
		}
		lease = menuLease{map[string]bool{}, time.Now().Add(30 * time.Minute)}
	}
	for key, entry := range session.Menus {
		if time.Now().After(entry.Until) {
			delete(session.Menus, key)
		}
	}
	if len(session.Menus) >= 8 {
		session.Menus = map[string]menuLease{}
	}
	for _, action := range actions {
		if isMenuScope(action) {
			lease.Scopes[action] = true
		}
	}
	session.Menus[token] = lease
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"lease": token, "expiresAt": lease.Until, "gates": lease.Scopes, "saved": true, "configured": true, "created": r.URL.Path == "/api/access" && r.Method == "PUT"})
}
func handleAccessLeave(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var value struct{ Scope string }
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		http.Error(w, "invalid menu", 400)
		return
	}
	accessMu.Lock()
	defer accessMu.Unlock()
	if session := accessSessions[pinCookie(r)]; session != nil && session.Home == settingsHome {
		token := r.Header.Get("X-GameShelf-Menu")
		if lease, ok := session.Menus[token]; ok {
			if value.Scope == "settings" {
				delete(session.Menus, token)
			} else {
				delete(lease.Scopes, value.Scope)
				session.Menus[token] = lease
			}
		}
	}
	w.WriteHeader(204)
}

func issueInitialGuardianLease(w http.ResponseWriter, r *http.Request) {
	issueMenuLease(w, r, []string{"admin"})
}

func hasWipeLease(r *http.Request) bool {
	accessMu.Lock()
	defer accessMu.Unlock()
	s := accessSessions[pinCookie(r)]
	return guardianSessionAllowed(s, r) && s.Home == settingsHome && time.Now().Before(s.Expires) && menuAuthorized(s, r, "wipe")
}
