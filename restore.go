package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

const maxRestoreArchive = 64 << 20
const maxRestoreExpanded = 128 << 20

type restoreArchive struct {
	state []byte
	settings []byte
	covers map[string][]byte
	folderCovers int
	logs bool
}

type restoreSelection struct { State, Settings, Covers bool }

func validRestoreFolder(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, "/\\\x00")
}

func parseRestoreArchive(data []byte) (restoreArchive, error) {
	result := restoreArchive{covers: make(map[string][]byte)}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil { return result, errors.New("invalid ZIP archive") }
	if len(zr.File) == 0 || len(zr.File) > 500 { return result, errors.New("archive must contain 1 to 500 files") }
	seen := make(map[string]bool)
	var expanded uint64
	for _, member := range zr.File {
		name := member.Name
		if seen[name] || name == "" || path.Clean(name) != name || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") || !member.Mode().IsRegular() {
			return result, fmt.Errorf("unsafe or duplicate archive entry %q", name)
		}
		seen[name] = true
		limit := uint64(8 << 20)
		switch name {
		case "library-state.json": limit = 4 << 20
		case "server-settings.json": limit = 512 << 10
		case "logs.txt": limit = 1 << 20
		default:
			parts := strings.Split(name, "/")
			if len(parts) != 3 || !validRestoreFolder(parts[1]) { return result, fmt.Errorf("unsupported archive entry %q", name) }
			if parts[0] == "covers" && parts[2] == "cover.png" { /* uploaded cover */
			} else if parts[0] == "folder-covers" && validRestoreFolder(parts[2]) { /* read-only library copy */
			} else { return result, fmt.Errorf("unsupported archive entry %q", name) }
		}
		if member.UncompressedSize64 > limit || expanded+member.UncompressedSize64 > maxRestoreExpanded { return result, errors.New("archive exceeds restore size limits") }
		expanded += member.UncompressedSize64
		reader, err := member.Open()
		if err != nil { return result, errors.New("cannot read archive entry") }
		contents, readErr := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil || uint64(len(contents)) != member.UncompressedSize64 { return result, errors.New("incomplete archive entry") }
		switch name {
		case "library-state.json":
			if _, err := parseLibraryMetadata(contents); err != nil { return result, fmt.Errorf("invalid library state: %w", err) }
			result.state = contents
		case "server-settings.json":
			var settings serverSettings
			if err := json.Unmarshal(contents, &settings); err != nil { return result, errors.New("invalid server settings") }
			result.settings = contents
		case "logs.txt": result.logs = true
		default:
			if strings.HasPrefix(name, "folder-covers/") { result.folderCovers++; continue }
			config, err := png.DecodeConfig(bytes.NewReader(contents))
			if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 { return result, fmt.Errorf("invalid uploaded cover %q", name) }
			if _, err := png.Decode(bytes.NewReader(contents)); err != nil { return result, fmt.Errorf("invalid uploaded cover %q", name) }
			result.covers[strings.Split(name, "/")[1]] = contents
		}
	}
	if len(result.state) == 0 && len(result.settings) == 0 && len(result.covers) == 0 { return result, errors.New("archive has no restorable data") }
	return result, nil
}

type restoreFile struct { destination, staged, backup string; existed, applied bool }

func safeRestoreParent(destination string) error {
	parent := filepath.Dir(destination)
	base := filepath.Clean(dataDir)
	settingsBase := filepath.Clean(settingsHome)
	if parent == base || parent == settingsBase { return nil }
	if filepath.Dir(filepath.Dir(parent)) != base || filepath.Base(filepath.Dir(parent)) != "covers" { return errors.New("restore path is outside app storage") }
	for _, directory := range []string{filepath.Dir(parent), parent} {
		if err := os.Mkdir(directory, 0700); err != nil && !os.IsExist(err) { return err }
		info, err := os.Lstat(directory)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 { return errors.New("cover storage has an unsafe directory") }
	}
	return nil
}

func stageRestoreFile(destination string, contents []byte) (restoreFile, error) {
	item := restoreFile{destination: destination}
	if err := safeRestoreParent(destination); err != nil { return item, err }
	if info, err := os.Lstat(destination); err == nil {
		if !info.Mode().IsRegular() { return item, errors.New("restore destination is not a regular file") }
		item.existed = true
	} else if !os.IsNotExist(err) { return item, err }
	file, err := os.CreateTemp(filepath.Dir(destination), ".restore-*.tmp")
	if err != nil { return item, err }
	item.staged = file.Name()
	if err = file.Chmod(0600); err == nil { _, err = file.Write(contents) }
	if err == nil { err = file.Sync() }
	if closeErr := file.Close(); err == nil { err = closeErr }
	return item, err
}

func applyRestoreFiles(files []restoreFile) error {
	defer func() { for _, item := range files { os.Remove(item.staged) } }()
	for i := range files {
		item := &files[i]
		if item.existed {
			backup, err := os.CreateTemp(filepath.Dir(item.destination), ".restore-original-*.tmp")
			if err != nil { rollbackRestore(files); return err }
			item.backup = backup.Name()
			backup.Close()
			os.Remove(item.backup)
			if err := os.Rename(item.destination, item.backup); err != nil { rollbackRestore(files); return err }
		}
		if err := os.Rename(item.staged, item.destination); err != nil { rollbackRestore(files); return err }
		item.applied = true
	}
	for _, item := range files { if item.backup != "" { os.Remove(item.backup) } }
	return nil
}

func rollbackRestore(files []restoreFile) {
	for i := len(files)-1; i >= 0; i-- {
		item := files[i]
		if item.applied { os.Remove(item.destination) }
		if item.backup != "" { if err := os.Rename(item.backup, item.destination); err != nil { logEvent("errors", "restore rollback failed for %s: %v", item.destination, err) } }
	}
}

func handleLibraryRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRestoreArchive))
	if err != nil { http.Error(w, "backup ZIP exceeds 64 MiB", http.StatusRequestEntityTooLarge); return }
	archive, err := parseRestoreArchive(data)
	if err != nil { http.Error(w, err.Error(), http.StatusBadRequest); return }
	digest := sha256.Sum256(data)
	sha := hex.EncodeToString(digest[:])
	if r.URL.Query().Get("apply") != "1" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"sha256": sha, "state": len(archive.state) > 0, "settings": len(archive.settings) > 0, "covers": len(archive.covers), "folderCoversSkipped": archive.folderCovers, "logsSkipped": archive.logs})
		return
	}
	if r.Header.Get("X-Preview-SHA256") != sha { http.Error(w, "backup changed since preview", http.StatusConflict); return }
	selection := restoreSelection{r.URL.Query().Get("state") == "1", r.URL.Query().Get("settings") == "1", r.URL.Query().Get("covers") == "1"}
	if (!selection.State || len(archive.state) == 0) && (!selection.Settings || len(archive.settings) == 0) && (!selection.Covers || len(archive.covers) == 0) { http.Error(w, "select available data to restore", http.StatusBadRequest); return }
	if selection.Settings && len(archive.settings) > 0 {
		var settings serverSettings
		json.Unmarshal(archive.settings, &settings)
		if err := validateServerSettings(settings); err != nil { http.Error(w, "saved server sources are not valid in this container; deselect settings", http.StatusBadRequest); return }
		for i:=range settings.Sources{settings.Sources[i].Password="";settings.Sources[i].PasswordCipher="";settings.Sources[i].HasPassword=false}
		settings,err=prepareNetworkSecrets(settings);if err!=nil{http.Error(w,"network locations could not be restored",http.StatusBadRequest);return}
		archive.settings,_=json.MarshalIndent(settings,"","  ")
	}
	refreshMu.Lock()
	files := make([]restoreFile, 0, len(archive.covers)+2)
	add := func(destination string, contents []byte) error {
		item, err := stageRestoreFile(destination, contents)
		files = append(files, item)
		return err
	}
	if selection.State && len(archive.state) > 0 { err = add(filepath.Join(dataDir, "library-state.json"), archive.state) }
	if err == nil && selection.Settings && len(archive.settings) > 0 { err = add(settingsFile(), archive.settings) }
	if err == nil && selection.Covers {
		names := make([]string, 0, len(archive.covers))
		for name := range archive.covers { names = append(names, name) }
		sort.Strings(names)
		for _, name := range names {
			if err = add(customCoverPath(name), archive.covers[name]); err != nil { break }
		}
	}
	if err == nil { err = applyRestoreFiles(files) } else { for _, item := range files { os.Remove(item.staged) } }
	if err == nil && selection.Settings && len(archive.settings) > 0 {
		var settings serverSettings
		json.Unmarshal(archive.settings, &settings)
		settings.LogOptions = normalizeLogOptions(settings.LogOptions)
		settingsMu.Lock(); configuredSettings = settings; settingsMu.Unlock()
		verboseLogging.Store(settings.Verbose)
		applicationLogs.Configure(settings.LogOptions)
	}
	refreshMu.Unlock()
	if err != nil { logEvent("errors", "library restore failed: %v", err); http.Error(w, "Restore failed; existing data was retained.", http.StatusServiceUnavailable); return }
	if err := refreshGames(); err != nil { logEvent("errors", "post-restore scan failed: %v", err); http.Error(w, "Restore saved, but the library scan failed. Refresh or restart the container.", http.StatusServiceUnavailable); return }
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"restored": true, "restartRequired": selection.Settings && len(archive.settings) > 0})
}
