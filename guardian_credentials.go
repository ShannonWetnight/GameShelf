package main

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
)

type guardianCredential struct {
	ID   string `json:"id"`
	Salt string `json:"salt"`
	Hash string `json:"hash"`
	Name string `json:"name,omitempty"`
}

func guardianCredentials(record *pinRecord) []guardianCredential {
	if record == nil {
		return nil
	}
	list := []guardianCredential{{ID: "guardian-1", Salt: record.Salt, Hash: record.Hash, Name: record.GuardianName}}
	if record.PrimaryDisabled {
		list = nil
	}
	if record.Secondary != nil {
		list = append(list, *record.Secondary)
	}
	return list
}
func guardianID(value string) string {
	if value == "" {
		return "guardian-1"
	}
	return value
}
func guardianCredentialByID(record *pinRecord, id string) (guardianCredential, bool) {
	for _, c := range guardianCredentials(record) {
		if c.ID == guardianID(id) {
			return c, true
		}
	}
	return guardianCredential{}, false
}
func validGuardianCredential(c guardianCredential) bool {
	salt, e1 := base64.StdEncoding.DecodeString(c.Salt)
	hash, e2 := base64.StdEncoding.DecodeString(c.Hash)
	return e1 == nil && e2 == nil && len(salt) == 16 && len(hash) == 32
}
func makeGuardianCredential(id, pin string) (guardianCredential, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return guardianCredential{}, err
	}
	hash, err := pbkdf2.Key(sha256.New, pin, salt, pinIterations, 32)
	return guardianCredential{ID: id, Salt: base64.StdEncoding.EncodeToString(salt), Hash: base64.StdEncoding.EncodeToString(hash)}, err
}
func matchGuardianPIN(record *pinRecord, pin, required string) string {
	matched := ""
	for _, c := range guardianCredentials(record) {
		salt, _ := base64.StdEncoding.DecodeString(c.Salt)
		expected, _ := base64.StdEncoding.DecodeString(c.Hash)
		actual, err := pbkdf2.Key(sha256.New, pin, salt, pinIterations, 32)
		if err == nil && subtle.ConstantTimeCompare(actual, expected) == 1 && (required == "" || required == c.ID) {
			matched = c.ID
		}
	}
	return matched
}
func guardianConstraint(r *http.Request) string {
	if view := profileView(r); view != nil && view.Profile.UsesGuardianPIN {
		return guardianID(view.Profile.GuardianID)
	}
	return ""
}
func guardianSessionAllowed(s *pinSession, r *http.Request) bool {
	if s != nil && strings.HasPrefix(s.GuardianID, "user:") {
		v := profileView(r)
		return v != nil && s.GuardianID == "user:"+v.Profile.ID
	}
	return s != nil && (guardianConstraint(r) == "" || s.GuardianID == guardianConstraint(r))
}

// A personal PIN can approve a user's Require PIN actions, never Guardian-only
// actions. Check this on grants, one-use permits, and menu leases independently.
func requiresGuardianPIN(r *http.Request, action string) bool {
	if action == "admin" || action == "wipe" {
		return true
	}
	policy, _, _ := currentAccessPolicy()
	return policyMode(combinedAccessPolicy(r, policy), action) == "guardian"
}
func pinAuthorityAllows(s *pinSession, r *http.Request, action string) bool {
	return guardianSessionAllowed(s, r) && (!strings.HasPrefix(s.GuardianID, "user:") || !requiresGuardianPIN(r, action))
}
func setGuardianCredential(record *pinRecord, id, pin string) error {
	id = guardianID(id)
	if !validPIN(pin) {
		return errors.New("Choose a 4-digit PIN")
	}
	if id == "guardian-2" && record.Salt == "" && !record.PrimaryDisabled {
		return errors.New("Create Guardian 1 first")
	}
	if id != "guardian-1" && id != "guardian-2" {
		return errors.New("Choose Guardian 1 or Guardian 2")
	}
	for _, other := range guardianCredentials(record) {
		if other.ID != id && matchGuardianPIN(record, pin, other.ID) != "" {
			return errors.New("Each Guardian must use a different PIN")
		}
	}
	c, err := makeGuardianCredential(id, pin)
	if err != nil {
		return err
	}
	if id == "guardian-1" {
		record.PrimaryDisabled = false
		record.Salt, record.Hash = c.Salt, c.Hash
	} else {
		if record.Secondary != nil {
			c.Name = record.Secondary.Name
		}
		record.Secondary = &c
	}
	return nil
}
func publicGuardians() []map[string]string {
	record, err := readPINRecord()
	list := []map[string]string{}
	if err == nil {
		for _, c := range guardianCredentials(record) {
			name := c.Name
			if name == "" {
				name = strings.Replace(c.ID, "guardian-", "Guardian ", 1)
			}
			list = append(list, map[string]string{"id": c.ID, "name": name})
		}
	}
	return list
}
func auditProfile(r *http.Request, event string) {
	actor := "Shared shelf"
	if view := profileView(r); view != nil {
		actor = view.Profile.Nickname
	}
	accessMu.Lock()
	s := accessSessions[pinCookie(r)]
	id := ""
	if s != nil {
		id = s.GuardianID
	}
	accessMu.Unlock()
	if id != "" {
		actor += " · " + strings.Replace(id, "guardian-", "Guardian ", 1)
	}
	logEvent("profile", "%s: %s", actor, event)
}

func replaceRequestCookie(r *http.Request, name, value string) {
	cookies := []string{}
	for _, c := range r.Cookies() {
		if c.Name != name {
			cookies = append(cookies, c.String())
		}
	}
	cookies = append(cookies, (&http.Cookie{Name: name, Value: value}).String())
	r.Header.Set("Cookie", strings.Join(cookies, "; "))
}

type auditReply struct {
	http.ResponseWriter
	status int
}

func (w *auditReply) WriteHeader(status int) { w.status = status; w.ResponseWriter.WriteHeader(status) }
func (w *auditReply) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(data)
}
