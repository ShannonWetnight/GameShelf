package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func environmentMap(env []string) map[string]string {
	result := make(map[string]string)
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			result[key] = value
		}
	}
	return result
}

func TestConnectorEnvironmentAllowlist(t *testing.T) {
	// Disposable values only: never print a real parent environment or credentials.
	allowed := []string{"TZ", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "LOCALDOMAIN", "RES_OPTIONS", "HOSTALIASES"}
	blocked := []string{"GAMESHELF_SENTINEL_SECRET", "AWS_SECRET_ACCESS_KEY", "RCLONE_CONFIG_OTHER_PASS", "RCLONE_CONFIG_GS_PASS", "RCLONE_CONFIG_GS_USER", "RCLONE_CONFIG", "RCLONE_SFTP_KEY_FILE", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "HOME", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "GODEBUG", "GOMAXPROCS", "PATH", "ALL_PROXY", "REQUEST_METHOD"}
	for _, key := range append(allowed, blocked...) {
		t.Setenv(key, "disposable-sentinel")
	}
	for _, protocol := range []string{"", "nfs", "sftp", "smb", "ftp", "ftps", "webdav", "keyscan"} {
		env := connectorEnvironment(protocol)
		if env == nil {
			t.Fatal("nil environment would inherit the parent")
		}
		got := environmentMap(env)
		for _, key := range blocked {
			if _, ok := got[key]; ok {
				t.Fatalf("%s inherited blocked variable %s", protocol, key)
			}
		}
		for _, key := range allowed {
			want := true
			if key == "LOCALDOMAIN" || key == "RES_OPTIONS" || key == "HOSTALIASES" {
				want = protocol != ""
			}
			if strings.HasPrefix(key, "SSL_CERT_") {
				want = protocol == "webdav" || protocol == "ftps"
			}
			if strings.Contains(strings.ToLower(key), "proxy") {
				want = protocol == "webdav"
			}
			_, ok := got[key]
			if ok != want {
				t.Fatalf("%s variable %s: present=%v want=%v", protocol, key, ok, want)
			}
		}
	}
	// Preserve explicit empty values (notably proxy bypass settings).
	t.Setenv("NO_PROXY", "")
	if value, ok := environmentMap(connectorEnvironment("webdav"))["NO_PROXY"]; !ok || value != "" {
		t.Fatal("explicit empty setting lost")
	}
}

func TestConnectorProcessesReceiveOnlySelectedCredentials(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process fixture")
	}
	dir := t.TempDir()
	oldHome, oldRclone, oldNFS := settingsHome, rcloneBinary, nfsBinary
	settingsHome = dir
	t.Cleanup(func() { settingsHome, rcloneBinary, nfsBinary = oldHome, oldRclone, oldNFS })
	t.Setenv("GAMESHELF_SENTINEL_SECRET", "disposable-secret")
	t.Setenv("RCLONE_CONFIG_OTHER_PASS", "disposable-other-password")
	t.Setenv("RCLONE_CONFIG_GS_PASS", "disposable-stale-password")
	t.Setenv("RCLONE_CONFIG_GS_TOKEN", "disposable-stale-token")
	t.Setenv("SSH_AUTH_SOCK", "/disposable-agent")
	t.Setenv("HTTPS_PROXY", "http://disposable-proxy")
	t.Setenv("SSL_CERT_FILE", "/disposable-ca")
	// The subprocess checks its own environment. No environment dump or real
	// credential is written to disk, stdout, stderr or test failure messages.
	script := `#!/bin/sh
[ -z "${GAMESHELF_SENTINEL_SECRET+x}${RCLONE_CONFIG_OTHER_PASS+x}${RCLONE_CONFIG_GS_TOKEN+x}" ] || exit 81
case "$1" in
 obscure)
  [ -z "${RCLONE_CONFIG_GS_PASS+x}${SSH_AUTH_SOCK+x}${HTTPS_PROXY+x}${SSL_CERT_FILE+x}" ] || exit 82
  IFS= read -r password
  [ "$password" = disposable-source-password ] || exit 83
  printf 'disposable-obscured-password\n'; exit 0 ;;
 list|cat)
  [ -z "${RCLONE_CONFIG_GS_PASS+x}${SSH_AUTH_SOCK+x}${HTTPS_PROXY+x}${SSL_CERT_FILE+x}" ] || exit 84 ;;
esac
printf '[]'
`
	binary := filepath.Join(dir, "connector")
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	rcloneBinary, nfsBinary = binary, binary
	for _, protocol := range []string{"smb", "nfs", "sftp", "webdav", "ftp", "ftps"} {
		for _, operation := range []string{"list", "cat"} {
			source := operationSource(protocol)
			source.Password = "disposable-source-password"
			cmd, cleanup, err := remoteCommand(context.Background(), source, operation, "Game/file.bin", false, 0, 7)
			if err != nil {
				t.Fatalf("%s preparation: %v", protocol, err)
			}
			got := environmentMap(cmd.Env)
			if protocol != "nfs" && (got["RCLONE_CONFIG_GS_USER"] != source.Username || got["RCLONE_CONFIG_GS_PASS"] != "disposable-obscured-password") {
				t.Fatal("selected credentials missing")
			}
			if _, ok := got["SSH_AUTH_SOCK"]; ok {
				t.Fatal("password source inherited agent")
			}
			for _, key := range []string{"RCLONE_CONFIG_OTHER_PASS", "RCLONE_CONFIG_GS_TOKEN", "GAMESHELF_SENTINEL_SECRET"} {
				if _, ok := got[key]; ok {
					t.Fatalf("%s inherited %s", protocol, key)
				}
			}
			_, err = cmd.Output()
			cleanup()
			if err != nil {
				t.Fatalf("%s %s process isolation: %v", protocol, operation, err)
			}
		}
	}
	// Preparing a second source cannot retain the first source's password.
	for _, protocol := range []string{"smb", "nfs", "sftp", "webdav", "ftp", "ftps"} {
		source := operationSource(protocol)
		source.Password = ""
		cmd, cleanup, err := remoteCommand(context.Background(), source, "list", "", false, 0, -1)
		if err != nil {
			t.Fatal(err)
		}
		got := environmentMap(cmd.Env)
		cleanup()
		if _, ok := got["RCLONE_CONFIG_GS_PASS"]; ok {
			t.Fatal("password leaked between sources")
		}
		_, agent := got["SSH_AUTH_SOCK"]
		if agent != (protocol == "sftp") {
			t.Fatal("passwordless SFTP agent compatibility changed")
		}
	}
}

func TestHostKeyDiscoveryEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process fixture")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
[ -z "${GAMESHELF_SENTINEL_SECRET+x}${RCLONE_CONFIG_GS_PASS+x}${SSH_AUTH_SOCK+x}${HTTPS_PROXY+x}${SSL_CERT_FILE+x}" ] || exit 85
printf 'nas ssh-ed25519 AAAA\n'
`
	if err := os.WriteFile(filepath.Join(dir, "ssh-keyscan"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	for _, key := range []string{"GAMESHELF_SENTINEL_SECRET", "RCLONE_CONFIG_GS_PASS", "SSH_AUTH_SOCK", "HTTPS_PROXY", "SSL_CERT_FILE"} {
		t.Setenv(key, "disposable-sentinel")
	}
	source := operationSource("sftp")
	source.HostKey = ""
	data, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handleNetworkTest(response, httptest.NewRequest("POST", "/api/network-test", strings.NewReader(string(data))))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"requiresTrust":true`) {
		t.Fatal("isolated host-key discovery failed")
	}
}
