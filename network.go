package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Connection passwords are write-only API fields. Ciphertext is persisted, never
// returned to browsers or exported. The encryption key stays in the data volume.
type networkSource struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Protocol       string `json:"protocol"`
	URL            string `json:"url"`
	Username       string `json:"username,omitempty"`
	Domain         string `json:"domain,omitempty"`
	Password       string `json:"password,omitempty"`
	HasPassword    bool   `json:"hasPassword,omitempty"`
	PasswordCipher string `json:"passwordCipher,omitempty"`
	HostKey        string `json:"hostKey,omitempty"`
	NFSVersion     int    `json:"nfsVersion,omitempty"`
	UID            int    `json:"uid,omitempty"`
	GID            int    `json:"gid,omitempty"`
}
type remoteItem struct {
	Path    string `json:"Path"`
	Size    int64  `json:"Size"`
	IsDir   bool   `json:"IsDir"`
	ModTime string `json:"ModTime"`
}

var metadataSlots = make(chan struct{}, 4)
var transferSlots = make(chan struct{}, 2)
var rcloneBinary = "rclone"
var nfsBinary = "/app/gameshelf-nfs"
var networkSecretMu sync.Mutex
var networkSourcesMu sync.RWMutex
var activeNetworkSources []networkSource

func setActiveSources(sources []networkSource) {
	networkSourcesMu.Lock()
	activeNetworkSources = append([]networkSource(nil), sources...)
	networkSourcesMu.Unlock()
}
func snapshotSources() []networkSource {
	networkSourcesMu.RLock()
	defer networkSourcesMu.RUnlock()
	return append([]networkSource(nil), activeNetworkSources...)
}

func hasLibrary(value serverSettings) bool { return len(libraryRoots(value))+len(value.Sources) > 0 }
func publicSettings(value serverSettings) serverSettings {
	value.Sources = append([]networkSource(nil), value.Sources...)
	for i := range value.Sources {
		s := &value.Sources[i]
		s.HasPassword = s.PasswordCipher != ""
		s.Password, s.PasswordCipher = "", ""
	}
	return value
}
func validSourceID(id string) bool { b, err := hex.DecodeString(id); return err == nil && len(b) == 16 }
func cleanText(value string, limit int) bool {
	return len(value) <= limit && !strings.ContainsFunc(value, unicode.IsControl)
}
func normalizeNetworkSource(value networkSource) (networkSource, error) {
	value.URL = strings.TrimSpace(value.URL)
	if value.Protocol == "nfs" && !strings.Contains(value.URL, "://") {
		value.URL = strings.Replace(value.URL, ":/", "/", 1)
	}
	value.Name = strings.TrimSpace(value.Name)
	if strings.HasPrefix(value.URL, `\\`) {
		value.URL = "smb://" + strings.ReplaceAll(strings.TrimLeft(value.URL, `\`), `\`, "/")
	}
	if !strings.Contains(value.URL, "://") {
		scheme := value.Protocol
		if scheme == "" {
			scheme = "smb"
		}
		if scheme == "webdav" {
			scheme = "https"
		}
		value.URL = scheme + "://" + strings.TrimPrefix(value.URL, "//")
	}
	u, err := url.Parse(value.URL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !cleanText(value.URL, 2048) {
		return value, errors.New("Enter a server and folder address without passwords or extra URL options")
	}
	u.Host = strings.ToLower(u.Host)
	scheme := strings.ToLower(u.Scheme)
	protocol := scheme
	if scheme == "http" || scheme == "https" || scheme == "webdav" || scheme == "webdavs" {
		protocol = "webdav"
	}
	if value.Protocol != "" && value.Protocol != protocol {
		return value, errors.New("The address does not match the selected connection type")
	}
	if protocol != "smb" && protocol != "nfs" && protocol != "sftp" && protocol != "webdav" && protocol != "ftp" && protocol != "ftps" {
		return value, errors.New("Choose SMB, NFS, SFTP, WebDAV, FTP, or FTPS")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return value, errors.New("Use a server port between 1 and 65535")
		}
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == ".." || strings.ContainsAny(part, "\\\x00") {
			return value, errors.New("Choose a folder without parent-directory references")
		}
	}
	u.Path = path.Clean("/" + strings.TrimPrefix(u.Path, "/"))
	u.RawPath = ""
	if protocol == "smb" && u.Path == "/" {
		return value, errors.New("Include the SMB share name, for example smb://server/games")
	}
	if scheme == "webdav" {
		u.Scheme = "http"
	}
	if scheme == "webdavs" {
		u.Scheme = "https"
	}
	value.Protocol = protocol
	value.URL = u.String()
	if value.ID != "" && !validSourceID(value.ID) {
		return value, errors.New("Invalid library source identifier")
	}
	if !cleanText(value.Name, 120) || !cleanText(value.Username, 256) || !cleanText(value.Domain, 256) || !cleanText(value.Password, 4096) {
		return value, errors.New("Connection details contain unsupported characters or are too long")
	}
	if value.Name == "" {
		value.Name = path.Base(u.Path) + " · " + u.Hostname()
		if u.Path == "/" {
			value.Name = u.Hostname()
		}
		if len(value.Name) > 120 {
			characters := []rune(value.Name)
			if len(characters) > 28 {
				characters = characters[:28]
			}
			value.Name = string(characters) + "…"
		}
	}
	if protocol == "nfs" {
		if value.UID == 0 {
			value.UID = 10001
		}
		if value.GID == 0 {
			value.GID = 10001
		}
	}
	if value.NFSVersion != 0 && value.NFSVersion != 3 && value.NFSVersion != 4 {
		return value, errors.New("Choose NFS version 3 or 4")
	}
	if value.UID < 0 || value.GID < 0 || value.UID > 2147483647 || value.GID > 2147483647 {
		return value, errors.New("NFS user and group IDs must be nonnegative numbers")
	}
	if protocol == "sftp" && value.HostKey != "" {
		parts := strings.Fields(value.HostKey)
		if len(parts) != 2 || !cleanText(value.HostKey, 16384) {
			return value, errors.New("Invalid SFTP server key")
		}
		if _, err := base64.StdEncoding.DecodeString(parts[1]); err != nil {
			return value, errors.New("Invalid SFTP server key")
		}
	}
	return value, nil
}
func newSourceID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value[:])
}
func sourceByID(id string) (networkSource, bool) {
	for _, s := range snapshotSources() {
		if s.ID == id {
			return s, true
		}
	}
	return networkSource{}, false
}
func savedSourceByID(id string) (networkSource, bool) {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	for _, s := range configuredSettings.Sources {
		if s.ID == id {
			return s, true
		}
	}
	return networkSource{}, false
}
func networkKey() ([]byte, error) {
	filename := filepath.Join(settingsHome, ".network-key")
	contents, err := os.ReadFile(filename)
	if err == nil {
		if len(contents) != 32 {
			return nil, errors.New("network key is invalid; restore the original data volume")
		}
		return contents, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(err) {
		return os.ReadFile(filename)
	}
	if err != nil {
		return nil, err
	}
	_, err = file.Write(key)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return key, err
}
func sealPassword(id, password string) (string, error) {
	networkSecretMu.Lock()
	defer networkSecretMu.Unlock()
	key, err := networkKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(password), []byte(id))), nil
}
func sourcePassword(source networkSource) (string, error) {
	if source.Password != "" {
		return source.Password, nil
	}
	if !source.HasPassword {
		return "", nil
	}
	if source.PasswordCipher == "" {
		old, ok := savedSourceByID(source.ID)
		if ok {
			source.PasswordCipher = old.PasswordCipher
		}
	}
	networkSecretMu.Lock()
	defer networkSecretMu.Unlock()
	key, err := networkKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(source.PasswordCipher)
	if err != nil || len(data) < gcm.NonceSize() {
		return "", errors.New("saved password is unavailable; enter it again")
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], []byte(source.ID))
	if err != nil {
		return "", errors.New("saved password is unavailable; enter it again")
	}
	return string(plain), nil
}
func prepareNetworkSecrets(value serverSettings) (serverSettings, error) {
	value.Sources = append([]networkSource(nil), value.Sources...)
	for i, source := range value.Sources {
		var err error
		source, err = normalizeNetworkSource(source)
		if err != nil {
			return value, err
		}
		if source.ID == "" {
			source.ID = newSourceID()
		}
		source.PasswordCipher = ""
		if source.Password != "" {
			source.PasswordCipher, err = sealPassword(source.ID, source.Password)
		} else if source.HasPassword {
			old, ok := savedSourceByID(source.ID)
			if !ok || old.PasswordCipher == "" {
				return value, errors.New("enter the password for this connection again")
			}
			source.PasswordCipher = old.PasswordCipher
		}
		if err != nil {
			return value, err
		}
		source.HasPassword = source.PasswordCipher != ""
		source.Password = ""
		value.Sources[i] = source
	}
	return value, nil
}

func safeRemotePath(value string) bool {
	return fs.ValidPath(value) && value != "." && !strings.ContainsAny(value, "\\\x00\r\n")
}

type boundedError struct{ bytes.Buffer }

func (b *boundedError) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 16384 {
		left := 16384 - b.Len()
		if len(p) > left {
			p = p[:left]
		}
		b.Buffer.Write(p)
	}
	return n, nil
}
func connectionError(stderr string, err error) error {
	text := strings.ToLower(stderr)
	if errors.Is(err, context.DeadlineExceeded) || strings.Contains(text, "timeout") || strings.Contains(text, "timed out") {
		return errors.New("The server did not respond in time. Check the address and network access")
	}
	if strings.Contains(text, "host key") || strings.Contains(text, "knownhosts") {
		return errors.New("The SFTP server key changed or is not trusted. Test the connection and verify its fingerprint")
	}
	if strings.Contains(text, "certificate") || strings.Contains(text, "x509") {
		return errors.New("The server's TLS certificate could not be verified")
	}
	if strings.Contains(text, "auth") || strings.Contains(text, "logon") || strings.Contains(text, "password") {
		return errors.New("Sign-in failed. Check the username, password, and share permissions")
	}
	if strings.Contains(text, "permission") || strings.Contains(text, "denied") {
		return errors.New("The server denied access. Check share permissions and, for NFS, the client user/group IDs and export policy")
	}
	return errors.New("Could not read this network folder. Check the address, share name, connection type, and server availability")
}
func remoteCommand(ctx context.Context, source networkSource, operation, relative string, recursive bool, offset, count int64) (*exec.Cmd, func(), error) {
	source, err := normalizeNetworkSource(source)
	if err != nil {
		return nil, func() {}, err
	}
	slots := metadataSlots
	if operation == "cat" && count > 20<<20 {
		slots = transferSlots
	}
	select {
	case slots <- struct{}{}:
	case <-ctx.Done():
		return nil, func() {}, ctx.Err()
	}
	prepared := false
	release := func() { <-slots }
	defer func() {
		if !prepared {
			release()
		}
	}()
	if relative != "" && !safeRemotePath(relative) {
		return nil, func() {}, errors.New("invalid network file path")
	}
	u, _ := url.Parse(source.URL)
	if source.Protocol == "nfs" {
		q := url.Values{}
		version := source.NFSVersion
		if version == 0 {
			version = 4
			if known, ok := nfsVersions.Load(source.ID + "\x00" + source.URL); ok {
				version = known.(int)
			}
		}
		q.Set("version", strconv.Itoa(version))
		q.Set("uid", strconv.Itoa(source.UID))
		q.Set("gid", strconv.Itoa(source.GID))
		if u.Port() != "" {
			q.Set("nfsport", u.Port())
			host := u.Hostname()
			if strings.Contains(host, ":") {
				u.Host = "[" + host + "]"
			} else {
				u.Host = host
			}
		}
		u.RawQuery = q.Encode()
		args := []string{operation, u.String(), relative, strconv.FormatBool(recursive), strconv.FormatInt(offset, 10), strconv.FormatInt(count, 10)}
		prepared = true
		return exec.CommandContext(ctx, nfsBinary, args...), release, nil
	}
	env := make([]string, 0)
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "RCLONE_") {
			env = append(env, item)
		}
	}
	config := map[string]string{"TYPE": source.Protocol, "HOST": u.Hostname(), "USER": source.Username, "DOMAIN": source.Domain, "PORT": u.Port()}
	remoteRoot := u.Path
	if source.Protocol == "smb" {
		remoteRoot = strings.TrimPrefix(u.Path, "/")
		if source.Username == "" {
			config["USER"] = "guest"
		}
	}
	if source.Protocol == "webdav" {
		config["URL"] = strings.TrimRight(u.String(), "/") + "/"
		config["VENDOR"] = "other"
		remoteRoot = ""
	}
	if source.Protocol == "ftps" {
		config["TYPE"] = "ftp"
		config["TLS"] = "true"
		if config["PORT"] == "" {
			config["PORT"] = "990"
		}
	}
	if source.Protocol == "ftp" && source.Username == "" {
		config["USER"] = "anonymous"
	}
	password, err := sourcePassword(source)
	if err != nil {
		return nil, func() {}, err
	}
	if password != "" {
		obscure := exec.CommandContext(ctx, rcloneBinary, "obscure", "-")
		obscure.Stdin = strings.NewReader(password + "\n")
		out, err := obscure.Output()
		if err != nil {
			return nil, func() {}, errors.New("network connector is unavailable")
		}
		config["PASS"] = strings.TrimSpace(string(out))
	}
	cleanup := func() {}
	if source.Protocol == "sftp" {
		if source.HostKey == "" {
			return nil, cleanup, errors.New("Test and trust the SFTP server key before adding this location")
		}
		file, err := os.CreateTemp(settingsHome, ".known-host-*")
		if err != nil {
			return nil, cleanup, err
		}
		filename := file.Name()
		cleanup = func() { os.Remove(filename) }
		host := u.Hostname()
		if u.Port() != "" && u.Port() != "22" {
			host = "[" + host + "]:" + u.Port()
		}
		_, err = file.WriteString(host + " " + source.HostKey + "\n")
		file.Close()
		if err != nil {
			cleanup()
			return nil, func() {}, err
		}
		config["KNOWN_HOSTS_FILE"] = filename
		config["DISABLE_HASHCHECK"] = "true"
	}
	for k, v := range config {
		if v != "" {
			env = append(env, "RCLONE_CONFIG_GS_"+k+"="+v)
		}
	}
	remote := "gs:" + strings.TrimRight(remoteRoot, "/")
	if relative != "" {
		remote += "/" + relative
	}
	if remoteRoot == "" {
		remote = "gs:" + relative
	}
	args := []string{"--config", os.DevNull, "--log-level", "ERROR", "--retries", "1", "--low-level-retries", "1", "--contimeout", "8s", "--timeout", "20s", "--stats", "0"}
	if operation == "list" {
		args = append(args, "lsjson", remote)
		if recursive {
			args = append(args, "--recursive")
		}
	} else {
		args = append(args, "cat", remote, "--offset", strconv.FormatInt(offset, 10))
		if count >= 0 {
			args = append(args, "--count", strconv.FormatInt(count, 10))
		}
	}
	cmd := exec.CommandContext(ctx, rcloneBinary, args...)
	cmd.Env = env
	prepared = true
	return cmd, func() { cleanup(); release() }, nil
}
func listRemoteVersion(ctx context.Context, source networkSource, recursive bool) ([]remoteItem, error) {
	cmd, cleanup, err := remoteCommand(ctx, source, "list", "", recursive, 0, -1)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	var stderr boundedError
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, errors.New("network connector is unavailable")
	}
	var items []remoteItem
	decodeErr := json.NewDecoder(io.LimitReader(stdout, 64<<20)).Decode(&items)
	if decodeErr != nil {
		cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if decodeErr != nil || waitErr != nil {
		return nil, connectionError(stderr.String(), ctx.Err())
	}
	if len(items) > 200000 {
		return nil, errors.New("This source exceeds the 200,000-entry scan limit; choose a smaller folder")
	}
	result := make([]remoteItem, 0, len(items))
	for _, item := range items {
		if safeRemotePath(item.Path) && (item.IsDir || item.Size >= 0) {
			result = append(result, item)
		}
	}
	return result, nil
}
func copyRemote(ctx context.Context, dst io.Writer, source networkSource, relative string, offset, count int64) error {
	cmd, cleanup, err := remoteCommand(ctx, source, "cat", relative, false, offset, count)
	if err != nil {
		return err
	}
	defer cleanup()
	var stderr boundedError
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return errors.New("network connector is unavailable")
	}
	written, copyErr := io.Copy(dst, stdout)
	if copyErr != nil {
		cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if copyErr != nil {
		return copyErr
	}
	if waitErr != nil {
		return connectionError(stderr.String(), ctx.Err())
	}
	if count >= 0 && written != count {
		return errors.New("The network file changed or the transfer ended early; refresh the library and try again")
	}
	return nil
}

func handleNetworkTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	var source networkSource
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 24576))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&source) != nil {
		http.Error(w, "Check the connection details", 400)
		return
	}
	var err error
	source, err = normalizeNetworkSource(source)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if source.ID == "" {
		source.ID = newSourceID()
	}
	source.PasswordCipher = ""
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	if source.Protocol == "sftp" && source.HostKey == "" {
		u, _ := url.Parse(source.URL)
		port := u.Port()
		if port == "" {
			port = "22"
		}
		cmd := exec.CommandContext(ctx, "ssh-keyscan", "-T", "6", "-p", port, "-t", "ed25519,ecdsa,rsa", u.Hostname())
		output, err := cmd.Output()
		if err != nil && len(output) == 0 {
			http.Error(w, "Could not read the SFTP server key. Check the address and port", 400)
			return
		}
		for _, line := range strings.Split(string(output), "\n") {
			parts := strings.Fields(line)
			if len(parts) < 3 || strings.HasPrefix(line, "#") {
				continue
			}
			key, err := base64.StdEncoding.DecodeString(parts[2])
			if err != nil {
				continue
			}
			sum := sha256.Sum256(key)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"requiresTrust": true, "hostKey": parts[1] + " " + parts[2], "fingerprint": "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])})
			return
		}
		http.Error(w, "The SFTP server did not provide a supported key", 400)
		return
	}
	items, err := listRemote(ctx, source, false)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	folders := 0
	for _, item := range items {
		if item.IsDir {
			folders++
		}
	}
	source.HasPassword = source.HasPassword || source.Password != ""
	source.Password, source.PasswordCipher = "", ""
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"connected": true, "folders": folders, "source": source})
}

func remoteRoot(id string) string { return "network:" + string(filepath.Separator) + id }
func remoteCoverName(entry *gameEntry) string {
	for _, candidate := range []string{"cover.jpg", "cover.png", "cover.jpeg", "folder.jpg", "folder.png", "folder.jpeg"} {
		for _, item := range entry.RemoteFiles {
			if item.Path == candidate {
				return candidate
			}
		}
	}
	return ""
}
func remoteFile(entry *gameEntry, relative string) (remoteItem, bool) {
	for _, item := range entry.RemoteFiles {
		if item.Path == relative {
			return item, true
		}
	}
	return remoteItem{}, false
}
func remoteCoverFile(ctx context.Context, entry *gameEntry, relative string) (*os.File, error) {
	item, ok := remoteFile(entry, relative)
	if !ok || item.Size > 20<<20 {
		return nil, errors.New("unsupported cover file")
	}
	source, ok := sourceByID(entry.NetworkID)
	if !ok {
		return nil, errors.New("network source no longer exists")
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{entry.NetworkID, entry.DirName, relative, item.ModTime, strconv.FormatInt(item.Size, 10)}, "\x00")))
	directory := filepath.Join(dataDir, "network-covers")
	filename := filepath.Join(directory, hex.EncodeToString(sum[:]))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if root, err := os.OpenRoot(directory); err == nil {
		file, _, openErr := openRegularFile(root, filepath.Base(filename))
		root.Close()
		if openErr == nil {
			return file, nil
		}
	}
	file, err := os.CreateTemp(directory, ".cover-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	if err = copyRemote(ctx, io.MultiWriter(file), source, path.Join(entry.DirName, relative), 0, item.Size); err != nil {
		file.Close()
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	if err = os.Rename(file.Name(), filename); err != nil {
		return nil, err
	}
	pruneRemoteCoverCache(directory)
	return os.Open(filename)
}
func addRemoteGameToZIP(ctx context.Context, archive *zip.Writer, entry *gameEntry, base string) error {
	source, ok := sourceByID(entry.NetworkID)
	if !ok {
		return errors.New("network source no longer exists")
	}
	for _, item := range entry.RemoteFiles {
		if !safeRemotePath(item.Path) {
			return errors.New("invalid network file")
		}
		writer, err := archive.Create(path.Join(base, item.Path))
		if err != nil {
			return err
		}
		if err = copyRemote(ctx, writer, source, path.Join(entry.DirName, item.Path), 0, item.Size); err != nil {
			return err
		}
	}
	return nil
}
func handleRemoteFiles(w http.ResponseWriter, r *http.Request, entry *gameEntry) {
	files := make([]gameFile, 0)
	for _, item := range entry.RemoteFiles {
		if len(files) >= 2000 {
			break
		}
		files = append(files, gameFile{item.Path, item.Size})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(struct {
		Files     []gameFile `json:"files"`
		Truncated bool       `json:"truncated"`
	}{files, len(entry.RemoteFiles) > 2000})
}
func serveRemoteFile(w http.ResponseWriter, r *http.Request, entry *gameEntry, relative string) {
	item, ok := remoteFile(entry, relative)
	if !ok {
		http.NotFound(w, r)
		return
	}
	source, ok := sourceByID(entry.NetworkID)
	if !ok {
		http.NotFound(w, r)
		return
	}
	offset, count := int64(0), item.Size
	status := 200
	if value := r.Header.Get("Range"); value != "" && r.Header.Get("If-Range") == "" {
		var err error
		offset, count, err = networkByteRange(value, item.Size)
		if err != nil {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", item.Size))
			w.WriteHeader(416)
			return
		}
		status = 206
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+count-1, item.Size))
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, sanitizeFilename(path.Base(relative))))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(count, 10))
	w.WriteHeader(status)
	if err := copyRemote(r.Context(), w, source, path.Join(entry.DirName, relative), offset, count); err != nil {
		logEvent("errors", "network download interrupted for %s", entry.Game.ID)
		panic(http.ErrAbortHandler)
	}
}
func sortedRemoteFiles(items []remoteItem) []remoteItem {
	sort.Slice(items, func(i, j int) bool { return items[i].Path < items[j].Path })
	return items
}

type networkFolder struct {
	Name, Source, NetworkID, Location string
	Files                             []remoteItem
	Size                              int64
}
type connectionState struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
}

var scanProgressMu sync.Mutex
var scanBusy bool
var scanMessage string
var connectionStates = make(map[string]connectionState)

func setScanProgress(busy bool, message string) {
	scanProgressMu.Lock()
	scanBusy, scanMessage = busy, message
	scanProgressMu.Unlock()
}
func setConnectionState(source networkSource, state, message string) {
	scanProgressMu.Lock()
	connectionStates[source.ID] = connectionState{source.ID, source.Name, state, message}
	scanProgressMu.Unlock()
}
func handleSourceStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	scanProgressMu.Lock()
	busy, message := scanBusy, scanMessage
	states := make([]connectionState, 0)
	for _, source := range snapshotSources() {
		if state, ok := connectionStates[source.ID]; ok {
			states = append(states, state)
		}
	}
	scanProgressMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"busy": busy, "message": message, "sources": states})
}

var networkList = listRemote

func collectNetworkFolders() ([]networkFolder, []*gameEntry, error) {
	folders := make([]networkFolder, 0)
	retained := make([]*gameEntry, 0)
	var firstError error
	successes := 0
	for _, source := range snapshotSources() {
		setConnectionState(source, "connecting", "")
		setScanProgress(true, "Reading "+source.Name+"…")
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		items, err := networkList(ctx, source, true)
		cancel()
		if err != nil {
			if firstError == nil {
				firstError = err
			}
			setConnectionState(source, "offline", err.Error())
			logEvent("errors", "network source %s is unavailable: %v", source.ID, err)
			gamesMu.RLock()
			for _, entry := range gamesMap {
				if entry.NetworkID == source.ID {
					retained = append(retained, entry)
				}
			}
			gamesMu.RUnlock()
			continue
		}
		successes++
		setConnectionState(source, "ready", "")
		byGame := make(map[string][]remoteItem)
		for _, item := range items {
			parts := strings.SplitN(item.Path, "/", 2)
			if len(parts) == 1 && item.IsDir {
				if _, ok := byGame[item.Path]; !ok {
					byGame[item.Path] = nil
				}
			}
		}
		for _, item := range items {
			parts := strings.SplitN(item.Path, "/", 2)
			if item.IsDir || len(parts) != 2 {
				continue
			}
			if _, ok := byGame[parts[0]]; !ok {
				continue
			}
			item.Path = parts[1]
			if safeRemotePath(item.Path) {
				byGame[parts[0]] = append(byGame[parts[0]], item)
			}
		}
		names := make([]string, 0, len(byGame))
		for name := range byGame {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			var size int64
			files := sortedRemoteFiles(byGame[name])
			for _, item := range files {
				if item.Size < 0 || size > int64(1<<63-1)-item.Size {
					return nil, nil, errors.New("network library sizes exceed the supported range")
				}
				size += item.Size
			}
			folders = append(folders, networkFolder{name, remoteRoot(source.ID), source.ID, strings.TrimRight(source.URL, "/") + "/" + url.PathEscape(name), files, size})
		}
	}
	if successes == 0 && len(retained) == 0 && firstError != nil && len(rootDirs) == 0 && rootDir == "" {
		return folders, retained, firstError
	}
	return folders, retained, nil
}
func sourcesEqual(a, b []networkSource) bool {
	one, _ := json.Marshal(a)
	two, _ := json.Marshal(b)
	return bytes.Equal(one, two)
}
func activateLibrary(value serverSettings) error {
	libraryRuntimeMu.Lock()
	defer libraryRuntimeMu.Unlock()
	refreshMu.Lock()
	rootDir, rootDirs = value.RootDir, libraryRoots(value)
	setActiveSources(value.Sources)
	// Removed locations must disappear even if a new server goes offline before
	// its first scan. Keep last-known entries only for still-configured sources.
	ids := make(map[string]bool)
	for _, source := range value.Sources {
		ids[source.ID] = true
	}
	gamesMu.Lock()
	for id, entry := range gamesMap {
		keep := ids[entry.NetworkID]
		if entry.NetworkID == "" {
			for _, root := range rootDirs {
				if entryRootDir(entry) == root {
					keep = true
					break
				}
			}
		}
		if !keep {
			delete(gamesMap, id)
		}
	}
	gamesMu.Unlock()
	refreshMu.Unlock()
	return refreshGames()
}
func serveNetworkCover(w http.ResponseWriter, r *http.Request, entry *gameEntry, relative string, editor bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	file, err := remoteCoverFile(ctx, entry, relative)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	head := make([]byte, 512)
	n, err := file.Read(head)
	if err != nil && err != io.EOF {
		http.NotFound(w, r)
		return
	}
	kind := http.DetectContentType(head[:n])
	if kind != "image/png" && kind != "image/jpeg" && kind != "image/gif" && kind != "image/webp" {
		http.NotFound(w, r)
		return
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if editor {
		w.Header().Set("Cache-Control", "no-store")
	}
	http.ServeContent(w, r, path.Base(relative), info.ModTime(), file)
}
func downloadRemoteGame(w http.ResponseWriter, r *http.Request, entry *gameEntry) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, sanitizeFilename(entry.Game.Name)))
	output := &zipResponseWriter{ResponseWriter: w}
	archive := zip.NewWriter(output)
	err := addRemoteGameToZIP(r.Context(), archive, entry, "")
	if err == nil {
		err = archive.Close()
	}
	if err != nil {
		logEvent("errors", "network ZIP failed for %s", entry.Game.ID)
		if output.started {
			panic(http.ErrAbortHandler)
		}
		w.Header().Del("Content-Disposition")
		w.Header().Del("Content-Type")
		http.Error(w, "Could not read this network game. Check the source connection and try again.", 503)
	}
}

func networkByteRange(header string, size int64) (int64, int64, error) {
	invalid := errors.New("unsupported byte range")
	header = strings.TrimSpace(header)
	if size <= 0 || !strings.HasPrefix(header, "bytes=") || strings.Contains(header, ",") {
		return 0, 0, invalid
	}
	parts := strings.Split(strings.TrimPrefix(header, "bytes="), "-")
	if len(parts) != 2 {
		return 0, 0, invalid
	}
	if parts[0] == "" {
		count, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || count <= 0 {
			return 0, 0, invalid
		}
		if count > size {
			count = size
		}
		return size - count, count, nil
	}
	offset, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || offset < 0 || offset >= size {
		return 0, 0, invalid
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < offset {
			return 0, 0, invalid
		}
		if end >= size {
			end = size - 1
		}
	}
	return offset, end - offset + 1, nil
}

var coverCacheMu sync.Mutex

func pruneRemoteCoverCache(directory string) {
	coverCacheMu.Lock()
	defer coverCacheMu.Unlock()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	type cached struct {
		name  string
		size  int64
		stamp time.Time
	}
	files := make([]cached, 0)
	var size int64
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") || !entry.Type().IsRegular() {
			continue
		}
		if info, err := entry.Info(); err == nil {
			size += info.Size()
			files = append(files, cached{entry.Name(), info.Size(), info.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].stamp.Before(files[j].stamp) })
	for _, file := range files {
		if size <= 256<<20 && time.Since(file.stamp) < 7*24*time.Hour {
			continue
		}
		if os.Remove(filepath.Join(directory, file.name)) == nil {
			size -= file.size
		}
	}
}

var nfsVersions sync.Map

func listRemote(ctx context.Context, source networkSource, recursive bool) ([]remoteItem, error) {
	normalized, err := normalizeNetworkSource(source)
	if err != nil {
		return nil, err
	}
	source = normalized
	if source.Protocol != "nfs" || source.NFSVersion != 0 {
		return listRemoteVersion(ctx, source, recursive)
	}
	key := source.ID + "\x00" + source.URL
	first := 4
	if known, ok := nfsVersions.Load(key); ok {
		first = known.(int)
	}
	for _, version := range []int{first, 7 - first} {
		attempt := source
		attempt.NFSVersion = version
		items, err := listRemoteVersion(ctx, attempt, recursive)
		if err == nil {
			nfsVersions.Store(key, version)
			return items, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
	}
	return nil, errors.New("Could not read this NFS export with NFS 4 or NFS 3. Check the export path, client access, and user/group IDs")
}
