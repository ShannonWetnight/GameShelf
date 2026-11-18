package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The operator enrolls exact leaf certificates out of band, before listening.
// A certificate's subject, issuer, and request headers confer no authority.
type shelfIdentities map[[sha256.Size]byte]string

func readIdentities(r io.Reader) (shelfIdentities, error) {
	ids := shelfIdentities{}
	owners := 0
	lines := bufio.NewScanner(r)
	for line := 1; lines.Scan(); line++ {
		fields := strings.Fields(lines.Text())
		if len(fields) == 0 {
			continue
		}
		if len(fields) != 2 || (fields[0] != "owner" && fields[0] != "member") {
			return nil, fmt.Errorf("invalid enrollment at line %d", line)
		}
		raw, err := hex.DecodeString(fields[1])
		if err != nil || len(raw) != sha256.Size {
			return nil, fmt.Errorf("invalid certificate fingerprint at line %d", line)
		}
		pin := [sha256.Size]byte(raw)
		if _, exists := ids[pin]; exists {
			return nil, fmt.Errorf("duplicate enrollment at line %d", line)
		}
		ids[pin] = fields[0]
		if fields[0] == "owner" {
			owners++
		}
	}
	if err := lines.Err(); err != nil {
		return nil, err
	}
	if owners == 0 {
		return nil, errors.New("enroll an owner before starting GameShelf")
	}
	return ids, nil
}

func (ids shelfIdentities) role(state *tls.ConnectionState) string {
	if state == nil || len(state.PeerCertificates) == 0 {
		return ""
	}
	cert := state.PeerCertificates[0]
	now := time.Now()
	if now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
		return ""
	}
	return ids[sha256.Sum256(cert.Raw)]
}

// Explicitly enumerate member API operations so new management routes default
// to owner-only. The underlying profile and Family Controls gates still run.
func memberRoute(r *http.Request) bool {
	p := r.URL.Path
	if p == "/api/profiles/self" && r.Method == http.MethodPut {
		return true
	}
	if r.Method == http.MethodPost {
		return p == "/api/profiles/login" || p == "/api/profiles/logout" || p == "/api/access/unlock" || p == "/api/profiles/self/open"
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	switch p {
	case "/", "/api/profiles/self", "/api/libraries", "/api/stats", "/api/version", "/api/setup", "/download-cart", "/download-playlist":
		return true
	case "/api/games":
		return !r.URL.Query().Has("forceRefresh")
	case "/api/profiles", "/api/access":
		return r.URL.RawQuery == ""
	}
	for _, prefix := range []string{"/api/game-files/", "/api/game-file/", "/covers/", "/download/"} {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	info, err := fs.Stat(webFS, "web"+p)
	return err == nil && info.Mode().IsRegular()
}

type memberContextKey struct{}

func isShelfMember(r *http.Request) bool {
	return r.Context().Value(memberContextKey{}) == true
}

func (ids shelfIdentities) gate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		switch ids.role(r.TLS) {
		case "owner":
		case "member":
			if !memberRoute(r) {
				http.Error(w, "An enrolled owner is required.", http.StatusForbidden)
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), memberContextKey{}, true))
		default:
			http.Error(w, "An enrolled certificate is required.", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func serveShelf(server *http.Server) error {
	dir, enabled := os.LookupEnv("GAMESHELF_IDENTITY_DIR")
	if !enabled {
		return server.ListenAndServe()
	}
	if !filepath.IsAbs(dir) {
		return errors.New("GAMESHELF_IDENTITY_DIR must be an absolute directory")
	}
	file, err := os.Open(filepath.Join(dir, "enrollments"))
	if err != nil {
		return err
	}
	ids, err := readIdentities(file)
	file.Close()
	if err != nil {
		return err
	}
	server.TLSConfig = &tls.Config{
		MinVersion: tls.VersionTLS13,
		ClientAuth: tls.RequireAnyClientCert,
		VerifyConnection: func(state tls.ConnectionState) error {
			if ids.role(&state) == "" {
				return errors.New("client certificate is expired or not enrolled")
			}
			return nil
		},
	}
	server.Handler = ids.gate(server.Handler)
	return server.ListenAndServeTLS(filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key"))
}
