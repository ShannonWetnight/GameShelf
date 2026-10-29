package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFrontendCodeIsRevalidatedWithoutChangingArtworkCaching(t *testing.T) {
	handler := frontendAssets(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, method := range []string{"GET", "HEAD"} {
		for _, path := range []string{"/", "/index.html", "/profiles.js?v=2", "/guardian.css", "/profile-avatars/cosmic-fox.webp"} {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(method, path, nil))
			cached := !strings.Contains(w.Header().Get("Cache-Control"), "no-store")
			if cached != strings.HasSuffix(path, ".webp") || w.Code != 204 {
				t.Fatal(method, path, w.Code, w.Header())
			}
		}
	}
}

func TestProfileValidationIdentifiesMissingDependency(t *testing.T) {
	for _, item := range []struct {
		name    string
		roles   []string
		message string
	}{
		{"", nil, "Choose a nickname and at least one role or group"},
		{"", []string{"child"}, "Choose a nickname"},
		{"Jamie", nil, "Choose at least one role or group"},
	} {
		db := defaultProfileDB()
		db.Profiles["test"] = familyProfile{ID: "test", Nickname: item.name, Roles: item.roles}
		if err := validateProfileDB(db); err == nil || err.Error() != item.message {
			t.Fatal("wrong dependency message", err, item.message)
		}
	}
}

func TestGuardianRemovalCanMigrateLinkedProfileToCustomGroup(t *testing.T) {
	setupFreshServer(t)
	c := familyCreate(t, nil)
	familyUnlock(t, "7392", []string{"admin"}, c)
	record, _ := readPINRecord()
	if err := setGuardianCredential(record, "guardian-2", "8642"); err != nil {
		t.Fatal(err)
	}
	if err := savePrivateJSON(pinPath(), record); err != nil {
		t.Fatal(err)
	}
	if err := autoGuardianProfile("guardian-1"); err != nil {
		t.Fatal(err)
	}
	profileMu.Lock()
	db, err := readProfileDBLocked()
	if err == nil {
		db.Groups = map[string]familyGroup{
			"g-guardians": defaultProfileGroups()["g-guardians"],
			"readers":     {ID: "readers", Name: "Readers", Roles: []string{"child"}},
			"guardians":   {ID: "guardians", Name: "Guardians", Roles: []string{"administrator"}},
		}
		err = saveProfileDBLocked(db, true)
	}
	profileMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"missing", "guardians"} {
		if w := familyCall(t, handleAccess, "DELETE", "/api/access?guardianID=guardian-1&group="+id, nil, c); w.Code != 400 {
			t.Fatal("invalid replacement group accepted", id, w.Code, w.Body.String())
		}
	}
	if w := familyCall(t, handleAccess, "DELETE", "/api/access?guardianID=guardian-1&group=readers", nil, c); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err = readProfileDBLocked()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range db.Profiles {
		if p.UsesGuardianPIN || p.GuardianID != "" || len(p.Roles) != 0 || len(p.Groups) != 1 || p.Groups[0] != "readers" || profileRequiresPIN(p) || p.Hash != "" || p.Salt != "" {
			t.Fatal("incomplete Guardian migration", p)
		}
	}
	if record, _ := readPINRecord(); matchGuardianPIN(record, "7392", "") != "" || matchGuardianPIN(record, "8642", "") != "guardian-2" {
		t.Fatal("Guardian authority was not preserved correctly")
	}
}
