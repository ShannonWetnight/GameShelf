package main

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOwnerEnrollment(t *testing.T) {
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("first owner")))
	for _, bad := range []string{"", "member " + hash, "owner short", "admin " + hash, "owner " + hash + "\nmember " + hash} {
		if _, err := readIdentities(strings.NewReader(bad)); err == nil {
			t.Errorf("accepted invalid enrollment %q", bad)
		}
	}
}

func TestCertificateAccess(t *testing.T) {
	newCert := func(subject string) *x509.Certificate {
		return &x509.Certificate{Raw: []byte(subject), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	}
	owner, member := newCert("owner"), newCert("member")
	expired := newCert("expired")
	expired.NotAfter = time.Now().Add(-time.Minute)
	config := fmt.Sprintf("owner %x\nmember %x\nowner %x", sha256.Sum256(owner.Raw), sha256.Sum256(member.Raw), sha256.Sum256(expired.Raw))
	ids, err := readIdentities(strings.NewReader(config))
	if err != nil {
		t.Fatal(err)
	}
	gate := ids.gate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isShelfMember(r) != (r.TLS.PeerCertificates[0] == member) {
			t.Error("incorrect request role")
		}
		w.WriteHeader(204)
	}))
	for _, tc := range []struct {
		cert         *x509.Certificate
		method, path string
		want         int
	}{
		{nil, "GET", "/", 403}, {newCert("unknown"), "GET", "/app.js", 403}, {expired, "GET", "/api/games", 403},
		{member, "GET", "/app.js", 204}, {member, "GET", "/api/games", 204}, {member, "GET", "/download/game", 204},
		{member, "POST", "/api/profiles/login", 204}, {member, "GET", "/api/games?forceRefresh", 403},
		{member, "GET", "/api/profiles?manage=1", 403}, {member, "GET", "/api/library-backup", 403},
		{member, "POST", "/api/setup", 403}, {member, "POST", "/api/server-settings/reset", 403},
		{member, "GET", "/api/new-admin-route", 403}, {owner, "POST", "/api/setup", 204},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("X-Forwarded-Client-Cert", "owner")
		if tc.cert != nil {
			r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{tc.cert}}
		}
		w := httptest.NewRecorder()
		gate.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%s %s: got %d, want %d", tc.method, tc.path, w.Code, tc.want)
		}
	}
}
