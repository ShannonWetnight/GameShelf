package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func operationFixture(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("connector process fixture requires a POSIX shell")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	t.Setenv("GAMESHELF_CONNECTOR_TEST_LOG", log)
	binary := filepath.Join(dir, "connector")
	// A local stand-in for either backend; never connects to a remote library.
	script := `#!/bin/sh
printf 'invoked\n' >> "$GAMESHELF_CONNECTOR_TEST_LOG"
for arg do
 case "$arg" in
 obscure) printf 'obscured-fixture-password\n'; exit 0 ;;
 lsjson|list) printf '[{"Path":"Game","IsDir":true},{"Path":"Game/file.bin","Size":7}]'; exit 0 ;;
 cat) printf 'payload'; exit 0 ;;
 esac
done
exit 2
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	oldRclone, oldNFS := rcloneBinary, nfsBinary
	rcloneBinary, nfsBinary = binary, binary
	t.Cleanup(func() { rcloneBinary, nfsBinary = oldRclone, oldNFS })
	return binary, log
}

func operationSource(protocol string) networkSource {
	scheme := protocol
	if protocol == "webdav" {
		scheme = "https"
	}
	return networkSource{Protocol: protocol, URL: scheme + "://nas/games", Username: "fixture-user", Password: "fixture-password", HostKey: "ssh-ed25519 AAAA"}
}

func TestRemoteCommandRejectsUnsupportedOperationsBeforeProcesses(t *testing.T) {
	_, log := operationFixture(t)
	operations := []string{"", "read", "lsjson", "obscure", "copy", "copyto", "move", "delete", "purge", "mkdir", "rename", "write", "LIST", "CAT", " list", "cat ", "list\ncat", "--help", "cat\x00", "fixture-password"}
	for _, protocol := range []string{"smb", "nfs", "sftp", "webdav", "ftp", "ftps"} {
		t.Run(protocol, func(t *testing.T) {
			for _, operation := range operations {
				cmd, cleanup, err := remoteCommand(context.Background(), operationSource(protocol), operation, "", false, 0, -1)
				if cleanup == nil {
					t.Fatal("missing error cleanup")
				}
				cleanup()
				if cmd != nil || err == nil || err.Error() != "unsupported network connector operation" {
					t.Fatalf("operation %q: cmd=%v error=%v", operation, cmd != nil, err)
				}
				if len(metadataSlots) != 0 || len(transferSlots) != 0 {
					t.Fatal("rejected operation leaked a connector slot")
				}
			}
		})
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatalf("rejected operation launched a connector (including password obscure): %v", err)
	}
	// Invalid source/secret/path and unavailable slots must not mask the error.
	oldSlots := metadataSlots
	metadataSlots = make(chan struct{})
	defer func() { metadataSlots = oldSlots }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cmd, cleanup, err := remoteCommand(ctx, networkSource{URL: "invalid", PasswordCipher: "private-cipher"}, "private-operation", "../private-path", false, 0, -1)
	cleanup()
	if cmd != nil || err == nil || err.Error() != "unsupported network connector operation" {
		t.Fatalf("unsupported operation did not fail first: %v", err)
	}
}

func TestRemoteCommandReadOperationsForBothAdapters(t *testing.T) {
	binary, _ := operationFixture(t)
	oldHome := settingsHome
	settingsHome = t.TempDir()
	t.Cleanup(func() { settingsHome = oldHome })
	for _, protocol := range []string{"smb", "nfs", "sftp", "webdav", "ftp", "ftps"} {
		t.Run(protocol, func(t *testing.T) {
			source := operationSource(protocol)
			for _, recursive := range []bool{false, true} {
				items, err := listRemoteVersion(context.Background(), source, recursive)
				if err != nil || len(items) != 2 || items[1].Path != "Game/file.bin" {
					t.Fatalf("list recursive=%v: %v %v", recursive, items, err)
				}
			}
			var downloaded bytes.Buffer
			if err := copyRemote(context.Background(), &downloaded, source, "Game/file.bin", 0, -1); err != nil || downloaded.String() != "payload" {
				t.Fatalf("read: %q %v", downloaded.String(), err)
			}
			// Preserve bounded/range reads used by artwork and individual downloads.
			cmd, cleanup, err := remoteCommand(context.Background(), source, "cat", "Game/file.bin", false, 3, 6)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			if cmd.Path != binary {
				t.Fatal("wrong connector selected")
			}
			if protocol == "nfs" {
				if cmd.Args[1] != "cat" || !reflect.DeepEqual(cmd.Args[3:], []string{"Game/file.bin", "false", "3", "6"}) {
					t.Fatalf("NFS range arguments: %q", cmd.Args)
				}
			} else {
				want := []string{"cat", "gs:/games/Game/file.bin", "--offset", "3", "--count", "6"}
				if protocol == "smb" {
					want[1] = "gs:games/Game/file.bin"
				}
				if protocol == "webdav" {
					want[1] = "gs:Game/file.bin"
				}
				if !reflect.DeepEqual(cmd.Args[len(cmd.Args)-len(want):], want) {
					t.Fatalf("rclone range arguments: %q", cmd.Args)
				}
			}
			if strings.Contains(strings.Join(cmd.Args, " "), source.Password) {
				t.Fatal("password exposed in arguments")
			}
		})
	}
}
