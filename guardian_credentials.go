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
}

func guardianCredentials(record *pinRecord) []guardianCredential {
	if record == nil {
		return nil
	}
	list := []guardianCredential{{"guardian-1", record.Salt, record.Hash}}
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
	return guardianCredential{id, base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(hash)}, err
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
	if view := profileView(r); view != nil && containsProfileID(view.Profile.Roles, "administrator") {
		return "profile:" + view.Profile.ID
	}
	return ""
}
func guardianSessionAllowed(s *pinSession, r *http.Request) bool {
	return s != nil && (guardianConstraint(r) == "" || s.GuardianID == guardianConstraint(r))
}
func setGuardianCredential(record *pinRecord, id, pin string) error {
	id = guardianID(id)
	if !validPIN(pin) {
		return errors.New("Choose a four-digit PIN")
	}
	if id == "guardian-2" && record.Salt == "" {
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
		record.Salt, record.Hash = c.Salt, c.Hash
	} else {
		record.Secondary = &c
	}
	return nil
}
func publicGuardians() []map[string]string {
	record, err := readPINRecord()
	list := []map[string]string{}
	if err == nil {
		for _, c := range guardianCredentials(record) {
			list = append(list, map[string]string{"id": c.ID, "name": strings.Replace(c.ID, "guardian-", "Guardian ", 1)})
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
