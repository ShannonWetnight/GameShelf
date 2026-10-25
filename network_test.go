package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"image"
	"image/png"
	"io"
	"math/big"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNetworkAddressesAndPublicSettings(t *testing.T) {
	for _, input := range []string{"smb://nas/games", "nas/games", `\\nas\games`, "nfs://nas/export/games", "sftp://nas/home/games", "https://nas/webdav/games", "ftp://nas/games", "ftps://nas/games"} {
		source, err := normalizeNetworkSource(networkSource{URL: input})
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		if source.Protocol == "nfs" && (source.NFSVersion != 0 || source.UID != 10001) {
			t.Fatal("NFS defaults are not unprivileged")
		}
	}
	for _, input := range []string{"sftp://-unsafe/games", "smb://user:password@nas/games", "smb://nas", "file:///etc", "https://nas/../private", "https://nas/games?option=unsafe", "smb://nas/games\n"} {
		if _, err := normalizeNetworkSource(networkSource{URL: input}); err == nil && !strings.HasSuffix(input, "\n") {
			t.Fatalf("unsafe address accepted: %q", input)
		}
	}
	original := serverSettings{Sources: []networkSource{{ID: newSourceID(), Password: "do-not-return", PasswordCipher: "private-cipher"}}}
	public := publicSettings(original)
	data, _ := json.Marshal(public)
	if strings.Contains(string(data), "do-not-return") || strings.Contains(string(data), "private-cipher") || !public.Sources[0].HasPassword {
		t.Fatal("password material leaked")
	}
	if original.Sources[0].Password == "" {
		t.Fatal("redaction mutated saved settings")
	}
}
func TestNetworkSecretsStayEncryptedAndPasswordsCanBeRetained(t *testing.T) {
	_, data := setupFreshServer(t)
	id := newSourceID()
	value := serverSettings{DataDir: data, RefreshInterval: "168h", Sources: []networkSource{{ID: id, URL: "smb://nas/games", Password: "unique-secret-value"}}}
	if err := saveServerSettings(value); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(settingsFile())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(contents, []byte("unique-secret-value")) {
		t.Fatal("plaintext password persisted")
	}
	source := configuredSettings.Sources[0]
	password, err := sourcePassword(source)
	if err != nil || password != "unique-secret-value" {
		t.Fatal("password could not be decrypted", err)
	}
	value = publicSettings(configuredSettings)
	if err := saveServerSettings(value); err != nil {
		t.Fatal(err)
	}
	if configuredSettings.Sources[0].PasswordCipher != source.PasswordCipher {
		t.Fatal("blank password field changed the saved secret")
	}
	value = publicSettings(configuredSettings)
	value.Sources[0].HasPassword = false
	if err := saveServerSettings(value); err != nil {
		t.Fatal(err)
	}
	if configuredSettings.Sources[0].PasswordCipher != "" {
		t.Fatal("explicit password clearing failed")
	}
}
func TestNetworkIndexKeepsStableIDsAndOfflineGames(t *testing.T) {
	_, _ = setupFreshServer(t)
	oldList, oldSources := networkList, snapshotSources()
	t.Cleanup(func() { networkList = oldList; setActiveSources(oldSources) })
	source := networkSource{ID: newSourceID(), URL: "smb://nas/games", Name: "My games", Protocol: "smb"}
	setActiveSources([]networkSource{source})
	rootDir = ""
	rootDirs = nil
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) {
		return []remoteItem{{Path: "Sample Game", IsDir: true}, {Path: "Sample Game/game.bin", Size: 7}, {Path: "Sample Game/cover.png", Size: 32}}, nil
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if len(gamesMap) != 1 {
		t.Fatal("network games were not indexed")
	}
	var entry *gameEntry
	for _, game := range gamesMap {
		entry = game
	}
	if entry.NetworkID != source.ID || entry.Game.SizeBytes != 39 || entry.Game.FileCount != 2 || entry.Game.CoverSource != "folder" {
		t.Fatalf("network entry: %#v", entry)
	}
	before := entry.Game.ID
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) {
		return nil, errors.New("server offline")
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if gamesMap[before] == nil {
		t.Fatal("offline source lost the last known game")
	}
	response := httptest.NewRecorder()
	handleSourceStatus(response, httptest.NewRequest("GET", "/api/source-status", nil))
	if !strings.Contains(response.Body.String(), "offline") {
		t.Fatal("offline source was not reported")
	}
	response = httptest.NewRecorder()
	handleGameFiles(response, httptest.NewRequest("GET", "/api/game-files/"+before, nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), "game.bin") {
		t.Fatal("remote file listing failed")
	}
}

func TestWebDAVNetworkLibraryStreamsFilesCoversZIPAndRanges(t *testing.T) {
	binary, err := exec.LookPath(rcloneBinary)
	if err != nil {
		t.Skip("rclone connector is not installed")
	}
	root, data := setupFreshServer(t)
	oldSources, oldBinary := snapshotSources(), rcloneBinary
	t.Cleanup(func() { setActiveSources(oldSources); rcloneBinary = oldBinary })
	rcloneBinary = binary
	game := filepath.Join(root, "Network Game")
	if err = os.Mkdir(game, 0700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("network-game-file-content")
	if err = os.WriteFile(filepath.Join(game, "game.bin"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err = png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	cover := encoded.Bytes()
	if err = os.WriteFile(filepath.Join(game, "cover.png"), cover, 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := exec.CommandContext(ctx, binary, "serve", "webdav", root, "--addr", address, "--user", "reader", "--pass", "test-password", "--read-only", "--log-level", "ERROR")
	var logs bytes.Buffer
	server.Stderr = &logs
	if err = server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); server.Wait() }()
	for n := 0; n < 100; n++ {
		connection, err := net.DialTimeout("tcp", address, 50*time.Millisecond)
		if err == nil {
			connection.Close()
			break
		}
		if n == 99 {
			t.Fatal("WebDAV fixture did not start", logs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	value := serverSettings{DataDir: data, RefreshInterval: "0", Sources: []networkSource{{ID: newSourceID(), URL: "http://" + address, Protocol: "webdav", Password: "test-password", Username: "reader", Name: "WebDAV fixture"}}}
	if err = saveServerSettings(value); err != nil {
		t.Fatal(err)
	}
	setActiveSources(configuredSettings.Sources)
	rootDir = ""
	rootDirs = nil
	if err = refreshGames(); err != nil {
		t.Fatal(err)
	}
	if len(gamesMap) != 1 {
		t.Fatal("network-only library not indexed")
	}
	var entry *gameEntry
	for _, item := range gamesMap {
		entry = item
	}
	response := httptest.NewRecorder()
	handleDownload(response, httptest.NewRequest("GET", "/download/"+entry.Game.ID, nil))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	archive, err := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var downloaded []byte
	for _, file := range archive.File {
		if file.Name == "game.bin" {
			reader, _ := file.Open()
			downloaded, _ = io.ReadAll(reader)
			reader.Close()
		}
	}
	if !bytes.Equal(downloaded, payload) {
		t.Fatal("network ZIP had incorrect content")
	}
	response = httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/api/game-file/"+entry.Game.ID+"?path=game.bin", nil)
	request.Header.Set("Range", "bytes=3-8")
	handleGameFileDownload(response, request)
	if response.Code != 206 || !bytes.Equal(response.Body.Bytes(), payload[3:9]) {
		t.Fatalf("network range response: %d %q", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	handleCover(response, httptest.NewRequest("GET", "/covers/"+entry.Game.ID, nil))
	if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), cover) {
		t.Fatal("network cover could not be served")
	}
	response = httptest.NewRecorder()
	handleDownloadCart(response, httptest.NewRequest("GET", "/download-playlist?game="+entry.Game.ID, nil))
	if response.Code != 200 {
		t.Fatal("network Playlist failed")
	}
	if _, err = zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len())); err != nil {
		t.Fatal("network Playlist was invalid", err)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(filepath.Join(settingsHome, ".network-key")); err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("network encryption key permissions are not private")
		}
	}
}

func TestNetworkByteRangesRejectMalformedAndClipValidRequests(t *testing.T) {
	for _, header := range []string{"bytes=abc-1", "bytes=5-2", "bytes=-0", "bytes=100-", "bytes=0-1,3-4", "items=0-2", "bytes=--2"} {
		if _, _, err := networkByteRange(header, 10); err == nil {
			t.Fatalf("invalid range accepted: %q", header)
		}
	}
	for _, test := range []struct {
		header       string
		start, count int64
	}{{"bytes=0-2", 0, 3}, {"bytes=8-99", 8, 2}, {"bytes=-3", 7, 3}, {"bytes=-99", 0, 10}, {"bytes=5-", 5, 5}} {
		start, count, err := networkByteRange(test.header, 10)
		if err != nil || start != test.start || count != test.count {
			t.Fatal(test, err, start, count)
		}
	}
}

func sshRSAHostKey(key *rsa.PublicKey) string {
	var blob bytes.Buffer
	integer := func(value []byte) []byte {
		if value[0]&128 != 0 {
			return append([]byte{0}, value...)
		}
		return value
	}
	for _, field := range [][]byte{[]byte("ssh-rsa"), integer(big.NewInt(int64(key.E)).Bytes()), integer(key.N.Bytes())} {
		binary.Write(&blob, binary.BigEndian, uint32(len(field)))
		blob.Write(field)
	}
	return "ssh-rsa " + base64.StdEncoding.EncodeToString(blob.Bytes())
}
func TestSFTPVerifiesPinnedServerKeyAndStreamsAuthenticatedFiles(t *testing.T) {
	binary, err := exec.LookPath(rcloneBinary)
	if err != nil {
		t.Skip("rclone connector is not installed")
	}
	root, _ := setupFreshServer(t)
	oldSources := snapshotSources()
	t.Cleanup(func() { setActiveSources(oldSources) })
	game := filepath.Join(root, "SSH Game")
	if err = os.Mkdir(game, 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(game, "game.txt"), []byte("ssh-file-data"), 0644); err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(cryptorand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "host-key")
	if err = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Offer a second key type; the client must negotiate the RSA key we pinned.
	additionalKey, err := ecdsa.GenerateKey(elliptic.P256(), cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encodedKey, err := x509.MarshalPKCS8PrivateKey(additionalKey)
	if err != nil {
		t.Fatal(err)
	}
	additionalFile := filepath.Join(t.TempDir(), "additional-host-key")
	if err := os.WriteFile(additionalFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedKey}), 0600); err != nil {
		t.Fatal(err)
	}
	server := exec.CommandContext(ctx, binary, "serve", "sftp", root, "--addr", address, "--key", keyFile, "--key", additionalFile, "--user", "reader", "--pass", "fixture-password", "--read-only", "--log-level", "ERROR")
	var logs bytes.Buffer
	server.Stderr = &logs
	if err = server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); server.Wait() }()
	for i := 0; i < 100; i++ {
		connection, err := net.DialTimeout("tcp", address, 50*time.Millisecond)
		if err == nil {
			connection.Close()
			break
		}
		if i == 99 {
			t.Fatal("SFTP fixture did not start", logs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	source := networkSource{ID: newSourceID(), Name: "SSH", Protocol: "sftp", URL: "sftp://" + address + "/", Username: "reader", Password: "fixture-password", HostKey: sshRSAHostKey(&key.PublicKey)}
	items, err := listRemote(ctx, source, true)
	if err != nil {
		t.Fatal("pinned SFTP connection failed", err, logs.String())
	}
	if len(items) != 2 {
		t.Fatalf("SFTP listing: %#v", items)
	}
	var content bytes.Buffer
	if err = copyRemote(ctx, &content, source, "SSH Game/game.txt", 0, 13); err != nil || content.String() != "ssh-file-data" {
		t.Fatal("SFTP stream failed", err, content.String())
	}
	other, err := rsa.GenerateKey(cryptorand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	source.HostKey = sshRSAHostKey(&other.PublicKey)
	if _, err = listRemote(ctx, source, false); err == nil || !strings.Contains(err.Error(), "server key") {
		t.Fatalf("changed server key was not rejected: %v", err)
	}
}

func TestRemovedNetworkSourceDisappearsWhenReplacementIsOffline(t *testing.T) {
	_, _ = setupFreshServer(t)
	oldList, oldSources := networkList, snapshotSources()
	t.Cleanup(func() { networkList = oldList; setActiveSources(oldSources) })
	previous := networkSource{ID: newSourceID(), URL: "smb://old/games", Protocol: "smb"}
	setActiveSources([]networkSource{previous})
	rootDir = ""
	rootDirs = nil
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) {
		return []remoteItem{{Path: "Old Game", IsDir: true}}, nil
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	replacement := networkSource{ID: newSourceID(), URL: "smb://new/games", Protocol: "smb"}
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) { return nil, errors.New("offline") }
	if err := activateLibrary(serverSettings{Sources: []networkSource{replacement}}); err == nil {
		t.Fatal("expected offline scan")
	}
	if len(gamesMap) != 0 {
		t.Fatal("removed source left games in the library")
	}
}

func TestNetworkSettingsBackupOmitsPasswordsAndEncryptionKey(t *testing.T) {
	_, data := setupFreshServer(t)
	value := serverSettings{DataDir: data, RefreshInterval: "168h", Sources: []networkSource{{URL: "smb://nas/games", Password: "secret-not-for-backups"}}}
	if err := saveServerSettings(value); err != nil {
		t.Fatal(err)
	}
	cipher := configuredSettings.Sources[0].PasswordCipher
	var output bytes.Buffer
	if err := writeLibraryBackupSelectionExtra(&output, false, false, true, map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range archive.File {
		if strings.Contains(file.Name, "network-key") {
			t.Fatal("encryption key included in backup")
		}
		if file.Name != "server-settings.json" {
			continue
		}
		found = true
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		contents, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(contents, []byte("secret-not-for-backups")) || bytes.Contains(contents, []byte(cipher)) {
			t.Fatal("credential material included in backup")
		}
		var settings serverSettings
		if err := json.Unmarshal(contents, &settings); err != nil {
			t.Fatal(err)
		}
		if len(settings.Sources) != 1 || settings.Sources[0].ID != configuredSettings.Sources[0].ID {
			t.Fatal("source identity missing from backup")
		}
	}
	if !found {
		t.Fatal("missing settings backup")
	}
}
