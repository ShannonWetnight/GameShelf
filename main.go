package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"io/fs"
	"log"
	"maps"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

//go:embed web/*
var webFS embed.FS

type Game struct {
	ID          string `json:"id"`
	IDPersisted bool   `json:"idPersisted"`
	Name        string `json:"name"`
	SizeBytes   int64  `json:"sizeBytes"`
	HasCover    bool   `json:"hasCover"`
	CoverSource string `json:"coverSource"`
	Path        string `json:"path"`
	FileCount   int    `json:"fileCount"`
	AddedAt     string `json:"addedAt"`
	Favorite    bool   `json:"favorite"`
 CoverStretch *bool `json:"coverStretch,omitempty"`
	Location string `json:"location,omitempty"`
	Unavailable bool `json:"unavailable,omitempty"`
}

type gameEntry struct {
	Game      Game
	DirName   string // directory name on disk
	RootDir   string // containing library source; empty uses the legacy primary source
	CoverKey  string // unique storage name for an uploaded cover
	CoverPath string // absolute path to cover, if any
	NetworkID string
	NetworkIdentity string
	RemoteFiles []remoteItem
}

var (
	rootDir       string
	rootDirs      []string
	dataDir       string
	gamesMu       sync.RWMutex
	refreshMu     sync.Mutex                    // serialize scans without blocking readers
	gamesMap      = make(map[string]*gameEntry) // id -> entry
	lastIndexedAt time.Time                    // last successful scan, protected by gamesMu
	// Protected by refreshMu; retain absent folders as well as active ones.
	cachedIDs                  map[string]string
	cachedIDRoot, cachedIDData string
	buildVersion               = "Development"
	buildChannel               = "development"
)

func main() {
	settings := initializeServerSettings()
	rootDir = settings.RootDir
	rootDirs = libraryRoots(settings)
	dataDir = settings.DataDir
	setActiveSources(settings.Sources)

	if needsFirstSetup(settings) {
		setupRequired.Store(true)
		log.Print("Welcome to GameShelf. Open port 8080 to choose your library folders.")
	} else if !hasLibrary(settings) {
		logEvent("system", "Library setup deferred; add locations in Advanced Settings")
	} else if len(settings.Sources) > 0 {
		setScanProgress(true, "Connecting to your libraries…")
		go func() {
			if err := refreshGames(); err != nil {
				logEvent("errors", "initial network scan: %v", err)
			}
		}()
	} else if err := refreshGames(); err != nil {
		setupRequired.Store(true)
		log.Printf("Library unavailable; open GameShelf to update your folders: %v", err)
	}
	go runAutoRefresh()
	go runHealthMonitor()

	mux := http.NewServeMux()

	// API endpoints
	mux.HandleFunc("/api/profiles", handleProfiles)
	mux.HandleFunc("/api/profiles/login", handleProfileLogin)
	mux.HandleFunc("/api/profiles/logout", handleProfileLogout)
	mux.HandleFunc("/api/profiles/catalog", handleProfileCatalog)
	mux.HandleFunc("/api/access", handleAccess)
	mux.HandleFunc("/api/access/leave", handleAccessLeave)
	mux.HandleFunc("/api/access/unlock", handleAccessUnlock)
 mux.HandleFunc("/api/access/enter",handleAccessEnter)
	mux.HandleFunc("/api/health", handleHealth)
	mux.HandleFunc("/api/health/check", handleHealth)
	mux.HandleFunc("/api/games", handleGames)
	mux.HandleFunc("/api/stats", handleStats)
	mux.HandleFunc("/api/game-files/", handleGameFiles)
	mux.HandleFunc("/api/game-file/", handleGameFileDownload)
	mux.HandleFunc("/api/version", handleVersion)
	mux.HandleFunc("/api/library-backup", handleLibraryBackup)
	mux.HandleFunc("/api/library-restore", handleLibraryRestore)
	mux.HandleFunc("/api/covers/", handleCoverUpload)
	mux.HandleFunc("/api/cover-source/", handleCoverSource)
	mux.HandleFunc("/api/game-title/", handleGameTitle)
	mux.HandleFunc("/api/favorite/", handleFavorite)
	mux.HandleFunc("/api/cover-fit/", handleCoverFit)
	mux.HandleFunc("/api/settings-events", handleSettingsEvent)
	mux.HandleFunc("/api/setup/restart", handleSetupRestart)
	mux.HandleFunc("/api/metadata-reset/", handleMetadataReset)
	mux.HandleFunc("/api/setup", handleSetup)
	mux.HandleFunc("/api/network-test", handleNetworkTest)
	mux.HandleFunc("/api/source-status", handleSourceStatus)
	mux.HandleFunc("/api/library-folders", handleLibraryFolders)
	mux.HandleFunc("/api/server-settings", handleServerSettings)
	mux.HandleFunc("/api/server-settings/reset", handleResetServerSettings)
	mux.HandleFunc("/api/logs", handleLogs)
	mux.HandleFunc("/download/", handleDownload)
	mux.HandleFunc("/download-cart", handleDownloadCart)
	mux.HandleFunc("/download-playlist", handleDownloadCart)
	mux.HandleFunc("/covers/", handleCover)

	// Static frontend
	sub, err := embedSubFS(webFS, "web")
	if err != nil {
		log.Fatalf("static FS error: %v", err)
	}

	fileServer := http.FileServer(http.FS(sub))
	mux.Handle("/", fileServer)

	addr := ":8080"

	logEvent("system", "GameShelf serving %s on %s", rootDir, addr)
	if err := http.ListenAndServe(addr, loggingMiddleware(setupGate(profileGate(accessGate(mux))))); err != nil {
		log.Fatal(err)
	}
}

// embedSubFS gets a subdirectory from an embed.FS
func embedSubFS(fsys embed.FS, dir string) (fs.FS, error) {
	return fs.Sub(fsys, dir)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if logTypeEnabled("requests") { log.Printf("[request] %s %s %s", r.Method, r.URL.Path, time.Since(start)) }
	})
}

func refreshInterval() time.Duration {
	value := os.Getenv("GAMESHELF_REFRESH_INTERVAL")
	if value == "" {
		return 168 * time.Hour
	}

	dur, err := time.ParseDuration(value)
	if err != nil {
		logEvent("errors", "invalid GAMESHELF_REFRESH_INTERVAL %q, using default 168h", value)
		return 168 * time.Hour
	}

	if dur <= 0 {
		return 0
	}

	return dur
}

func configuredRefreshInterval(value string) time.Duration {
	if value == "0" { return 0 }
	interval, err := time.ParseDuration(value)
	if err != nil || interval < 0 { return 168 * time.Hour }
	return interval
}

// -------- Game indexing --------

// libraryState stores metadata and ID assignments for each folder. It
// lives outside GAMESHELF_ROOT so the game library can remain read-only.
type libraryState struct {
	Version   int               `json:"version"`
	FirstSeen map[string]string `json:"firstSeen"`
	Titles    map[string]string `json:"titles,omitempty"`
	Favorites map[string]bool   `json:"favorites,omitempty"`
 CoverStretch map[string]bool `json:"coverStretch,omitempty"`
	IDs       map[string]string `json:"ids,omitempty"` // exact directory name -> stable ID
}

func readLibraryMetadata() (libraryState, error) {
	contents, err := os.ReadFile(filepath.Join(dataDir, "library-state.json"))
	if os.IsNotExist(err) {
		return libraryState{Version: 1, FirstSeen: make(map[string]string), Titles: make(map[string]string), Favorites: make(map[string]bool)}, nil
	}
	if err != nil {
		return libraryState{}, err
	}
	return parseLibraryMetadata(contents)
}

func parseLibraryMetadata(contents []byte) (libraryState, error) {
	var state libraryState
	if err := json.Unmarshal(contents, &state); err != nil {
		return libraryState{}, err
	}
	if state.Version != 1 || state.FirstSeen == nil {
		return libraryState{}, fmt.Errorf("unsupported library state format")
	}
	for path, value := range state.FirstSeen {
		if path == "" || value == "" {
			return libraryState{}, fmt.Errorf("invalid library state entry")
		}
		if _, err := time.Parse(time.RFC3339, value); err != nil {
			return libraryState{}, fmt.Errorf("invalid date for %q: %w", path, err)
		}
	}
	if state.Titles == nil {
		state.Titles = make(map[string]string)
	}
	if state.Favorites == nil { state.Favorites = make(map[string]bool) }
	for path, title := range state.Titles {
		if path == "" || !validGameTitle(title) {
			return libraryState{}, fmt.Errorf("invalid title for %q", path)
		}
	}
	if state.CoverStretch == nil { state.CoverStretch=make(map[string]bool) }
 for folder := range state.CoverStretch { if folder=="" {return libraryState{},fmt.Errorf("invalid cover-fit folder")} }
 for folder := range state.Favorites { if folder == "" { return libraryState{}, fmt.Errorf("invalid favorite folder") } }
	owners := make(map[string]string)
	for name, id := range state.IDs {
		if name == "" || id == "" || id != strings.TrimSpace(id) || strings.ContainsAny(id, "/\\") {
			return libraryState{}, fmt.Errorf("invalid game ID assignment for %q", name)
		}
		if _, exists := owners[id]; exists {
			return libraryState{}, fmt.Errorf("duplicate game ID assignment %q", id)
		}
		owners[id] = name
	}
	return state, nil
}

func readLibraryState() (map[string]string, error) {
	state, err := readLibraryMetadata()
	return state.FirstSeen, err
}

func writeLibraryMetadata(state libraryState) error {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return err
	}
	contents, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dataDir, ".library-state-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(append(contents, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(dataDir, "library-state.json"))
}

func writeLibraryState(firstSeen map[string]string) error {
	state, err := readLibraryMetadata()
	if err != nil {
		return err
	}
	state.FirstSeen = firstSeen
	return writeLibraryMetadata(state)
}

func validGameTitle(title string) bool {
	if title != strings.TrimSpace(title) || title == "" || !utf8.ValidString(title) || utf8.RuneCountInString(title) > 120 {
		return false
	}
	return !strings.ContainsAny(title, "\r\n\x00")
}

func customCoverPath(dirName string) string {
	return filepath.Join(dataDir, "covers", dirName, "cover.png")
}

func entryRootDir(entry *gameEntry) string {
	if entry.RootDir != "" { return entry.RootDir }
	return rootDir
}

func entryCoverKey(entry *gameEntry) string {
	if entry.CoverKey != "" { return entry.CoverKey }
	return entry.DirName
}

func sourceCoverKey(source, name string) string {
	if source == rootDir { return name }
	hash := sha256.Sum256([]byte(filepath.Join(source, name)))
	return fmt.Sprintf("source-%x", hash[:16])
}

func legacyCustomCoverPath(dirName string) string {
	hash := sha256.Sum256([]byte(dirName))
	return filepath.Join(dataDir, "covers", fmt.Sprintf("%x.png", hash))
}

// assignGameIDs preserves saved assignments, including absent folders, so an old
// URL never changes owners. On upgrade, the last name in ReadDir's sorted order
// keeps a shared legacy slug, matching the old index's overwrite behavior.
func assignGameIDs(entries []os.DirEntry, saved map[string]string) (map[string]string, bool) {
	ids := make(map[string]string, len(saved)+len(entries))
	used := make(map[string]bool)
	winners := make(map[string]string)
	for name, id := range saved {
		ids[name] = id
		used[id] = true
	}
	reserved := make(map[string]bool)
	for _, entry := range entries {
		if entry.IsDir() {
			slug := slugify(entry.Name())
			reserved[slug] = true
			winners[slug] = entry.Name()
		}
	}
	changed := false
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || ids[name] != "" {
			continue
		}
		slug := slugify(name)
		id := slug
		if id == "" || used[id] || winners[slug] != name {
			prefix := slug
			if prefix == "" {
				prefix = "game"
			}
			hash := sha256.Sum256([]byte(name))
			base := fmt.Sprintf("%s-%x", prefix, hash)
			id = base
			// Also reserve natural slugs: a folder can literally be named like
			// a generated ID. The counter handles that and even a hash collision.
			for n := 1; used[id] || reserved[id]; n++ {
				id = fmt.Sprintf("%s-%d", base, n)
			}
		}
		ids[name] = id
		used[id] = true
		changed = true
	}
	return ids, changed
}

func refreshGames() error {
	refreshMu.Lock()
	defer refreshMu.Unlock()
	setScanProgress(true,"Scanning your games…")
	defer setScanProgress(false,"")

	nextGames := make(map[string]*gameEntry)
	state, stateErr := readLibraryMetadata()
	firstSeen := state.FirstSeen
	if stateErr != nil {
		logEvent("errors", "Date-added state unavailable: %v", stateErr)
	}
	nextFirstSeen := make(map[string]string)
	stateChanged := false

	var primaryEntries []os.DirEntry
	if rootDir!=""{var err error;primaryEntries,err=os.ReadDir(rootDir);if err!=nil{return fmt.Errorf("reading library source %s: %w",rootDir,err)}}
	scanRoots := rootDirs
	if len(scanRoots) == 0 && rootDir!="" { scanRoots = []string{rootDir} }
	type sourceFolder struct { source, name, key string; network *networkFolder }
	folders := make([]sourceFolder, 0)
	// A share mounted below /games is a source container, not a game in /games.
	isSourceContainer := func(source, name string) bool {
		child := filepath.Join(source, name)
		for _, other := range scanRoots {
			if other != source && pathInside(child, other) { return true }
		}
		return false
	}
	primaryGameEntries := make([]os.DirEntry, 0, len(primaryEntries))
	for _, e := range primaryEntries {
		if e.IsDir() && !isSourceContainer(rootDir, e.Name()) {
			primaryGameEntries = append(primaryGameEntries, e)
			folders = append(folders, sourceFolder{rootDir, e.Name(), e.Name(),nil})
		}
	}
	for _, source := range scanRoots {
		if source == rootDir { continue }
		entries, err := os.ReadDir(source)
		if err != nil { return fmt.Errorf("reading library source %s: %w", source, err) }
		for _, e := range entries { if e.IsDir() && !isSourceContainer(source, e.Name()) { folders = append(folders, sourceFolder{source, e.Name(), filepath.Join(source, e.Name()),nil}) } }
	}
	networkFolders,retained,networkErr:=collectNetworkFolders(state);if networkErr!=nil{return networkErr}
	for i:=range networkFolders{folder:=&networkFolders[i];folders=append(folders,sourceFolder{folder.Source,folder.Name,filepath.Join(folder.Source,folder.Name),folder})}
	// A different library/storage pair must not inherit process-local assignments.
	rootSignature := strings.Join(scanRoots, "\x00")
	for _,source:=range snapshotSources(){rootSignature+="\x00"+source.ID}
	if cachedIDRoot != rootSignature || cachedIDData != dataDir {
		cachedIDs = nil
	}
	// Disk is authoritative on recovery. Reuse cached IDs only if neither their
	// folder nor their ID has been claimed by a saved assignment.
	savedIDs := make(map[string]string)
	usedIDs := make(map[string]bool)
	for name, id := range state.IDs {
		savedIDs[name] = id
		usedIDs[id] = true
	}
	names := make([]string, 0, len(cachedIDs))
	for name := range cachedIDs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		id := cachedIDs[name]
		if savedIDs[name] == "" && !usedIDs[id] {
			savedIDs[name] = id
			usedIDs[id] = true
		}
	}
	// Reserve offline IDs before allocating IDs for freshly discovered folders.
	for _, entry := range retained {
		key := entry.Game.Path
		if id := savedIDs[key]; id != "" {
			entry.Game.ID = id
		} else if !usedIDs[entry.Game.ID] {
			savedIDs[key] = entry.Game.ID
			usedIDs[entry.Game.ID] = true
		}
	}
	ids, _ := assignGameIDs(primaryGameEntries, savedIDs)
	used := make(map[string]bool)
	for _, id := range ids { used[id] = true }
	for _, folder := range folders {
		if folder.source == rootDir || ids[folder.key] != "" { continue }
		base := slugify(folder.name)
		if base == "" { base = "game" }
		id := base
		if used[id] {
			hash := sha256.Sum256([]byte(folder.key))
			id = fmt.Sprintf("%s-%x", base, hash[:8])
			for n := 1; used[id]; n++ { id = fmt.Sprintf("%s-%x-%d", base, hash[:8], n) }
		}
		ids[folder.key] = id
		used[id] = true
	}
	persistedIDs := state.IDs
	idsChanged := !maps.Equal(ids, persistedIDs)
	state.IDs = ids
	stateChanged = idsChanged

	for _, folder := range folders {
		dirName := folder.name
		if logTypeEnabled("scans") { log.Printf("[scan] scanning %q", dirName) }
		id := ids[folder.key]
		absPath := filepath.Join(folder.source, dirName)

		var size int64;var fileCount int;var err error
		if folder.network!=nil{size,fileCount=folder.network.Size,len(folder.network.Files)}else{size,fileCount,err=dirStats(absPath)}
		if err != nil {
			return fmt.Errorf("scanning game %q: %w", dirName, err)
		}

		coverKey := sourceCoverKey(folder.source, dirName)
		cover := customCoverPath(coverKey)
		coverSource := "uploaded"
		if info, err := os.Lstat(cover); err != nil || !info.Mode().IsRegular() {
			cover = legacyCustomCoverPath(coverKey)
			if info, err := os.Lstat(cover); err != nil || !info.Mode().IsRegular() {
				if folder.network!=nil{temp:=&gameEntry{RemoteFiles:folder.network.Files};if relative:=remoteCoverName(temp);relative!=""{cover=filepath.Join(absPath,relative)}else{cover=""}}else{cover = findCover(absPath)}
				coverSource = "folder"
			}
		}
		if cover == "" {
			coverSource = "placeholder"
		}
		addedAt := ""
		if stateErr == nil {
			addedAt = firstSeen[absPath]
			if addedAt == "" {
				addedAt = time.Now().UTC().Format(time.RFC3339)
				stateChanged = true
			}
			nextFirstSeen[absPath] = addedAt
		} else {
			gamesMu.RLock()
			if old := gamesMap[id]; old != nil && old.Game.Path == absPath {
				addedAt = old.Game.AddedAt
			}
			gamesMu.RUnlock()
		}

		name := dirName
		if custom := state.Titles[absPath]; custom != "" {
			name = custom
		}
		entry := &gameEntry{
			Game: Game{
				ID:          id,
				Name:        name,
				SizeBytes:   size,
				HasCover:    cover != "",
				CoverSource: coverSource,
				Path:        absPath,
				FileCount:   fileCount,
				AddedAt:     addedAt,
				Favorite:    state.Favorites[absPath],
 CoverStretch: coverStretchOverride(state,absPath),
			},
			DirName:   dirName,
			RootDir:   folder.source,
			CoverKey:  coverKey,
			CoverPath: cover,
		}

		if folder.network != nil {
			entry.NetworkID = folder.network.NetworkID
			entry.RemoteFiles = folder.network.Files
			entry.Game.Location = folder.network.Location
			entry.NetworkIdentity = folder.network.Identity
		}
		nextGames[id] = entry
	}
	for _, entry := range retained {
		// A saved assignment or fresh scan always wins over a stale snapshot.
		if ids[entry.Game.Path] == entry.Game.ID && nextGames[entry.Game.ID] == nil {
			nextGames[entry.Game.ID] = entry
			if entry.Game.AddedAt != "" {
				nextFirstSeen[entry.Game.Path] = entry.Game.AddedAt
			}
		}
	}
	if stateErr == nil {
		if len(nextFirstSeen) != len(firstSeen) {
			stateChanged = true
		}
		if stateChanged {
			state.FirstSeen = nextFirstSeen
			if err := writeLibraryMetadata(state); err != nil {
				if idsChanged {
					logEvent("errors", "Game ID assignments are temporary (in memory only): %v; URLs may change after restart if the folder set or saved state changes", err)
				}
				logEvent("errors", "Date-added state could not be saved: %v", err)
				for _, entry := range nextGames {
					if firstSeen[entry.Game.Path] == "" {
						entry.Game.AddedAt = ""
					}
				}
			} else {
				persistedIDs = ids
			}
		}
	}
	for key, id := range ids {
		if entry := nextGames[id]; entry != nil && (entry.DirName == key || entry.Game.Path == key) {
			entry.Game.IDPersisted = persistedIDs[key] == id
		}
	}
	if stateErr != nil && idsChanged {
		logEvent("errors", "Game ID assignments are temporary (in memory only): library state unavailable; URLs may change after restart if the folder set or saved state changes")
	}
	cachedIDs, cachedIDRoot, cachedIDData = ids, rootSignature, dataDir

	// Publish only a complete scan; readers keep the last successful index.
	gamesMu.Lock()
	gamesMap = nextGames
	lastIndexedAt = time.Now().UTC()
	gamesMu.Unlock()

	if err := writeNetworkSnapshot(nextGames); err != nil {
		logEvent("errors", "Network index snapshot could not be saved; offline browsing after restart may be unavailable: %v", err)
	}
	logEvent("library", "Indexed %d games", len(nextGames))
	return nil
}

func slugify(name string) string {
    s := strings.ToLower(strings.TrimSpace(name))

    // Replace all known bad characters with "-"
    replacer := strings.NewReplacer(
        " ", "-",  // space → hyphen
        "_", "-",  // underscore → hyphen
        "/", "-",  // slash → hyphen
        "\\", "-", // backslash → hyphen
        ":", "-",  // colon → hyphen
        ";", "-",  // semicolon → hyphen
        "'", "",   // apostrophe → remove
        `"`, "",   // double quote → remove
    )

    s = replacer.Replace(s)

    // Collapse repeating hyphens
    for strings.Contains(s, "--") {
        s = strings.ReplaceAll(s, "--", "-")
    }

    // Trim leftover leading/trailing hyphens
    s = strings.Trim(s, "-")

    return s
}

func dirStats(root string) (int64, int, error) {
	var size int64
	var files int
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		size += info.Size()
		files++
		return nil
	})
	return size, files, err
}

// openChildRoot rejects links and pins the checked directory across renames.
func openChildRoot(parent *os.Root, name string) (*os.Root, error) {
	before, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() {
		return nil, fmt.Errorf("not a physical directory: %s", name)
	}
	child, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	after, err := child.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		child.Close()
		return nil, fmt.Errorf("directory changed: %s", name)
	}
	return child, nil
}

func openGameRoot(entry *gameEntry) (*os.Root, error) {
	if entry.NetworkID!=""{return nil,errors.New("network games use the read-only network connector")}
	if !filepath.IsLocal(entry.DirName) || filepath.Base(entry.DirName) != entry.DirName {
		return nil, fmt.Errorf("invalid game directory")
	}
	library, err := os.OpenRoot(entryRootDir(entry))
	if err != nil {
		return nil, err
	}
	defer library.Close()
	return openChildRoot(library, entry.DirName)
}

// openRegularFile walks pinned directories and serves the validated descriptor,
// never reopening a checked pathname. Root also prevents escape during lookup.
func openRegularFile(root *os.Root, rel string) (*os.File, os.FileInfo, error) {
	if !filepath.IsLocal(rel) || rel == "." || strings.Contains(rel, "\\") {
		return nil, nil, fmt.Errorf("invalid file path")
	}
	parts := strings.Split(filepath.Clean(rel), string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		child, err := openChildRoot(root, part)
		if err != nil {
			return nil, nil, err
		}
		defer child.Close()
		root = child
	}
	name := parts[len(parts)-1]
	before, err := root.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("not a regular file: %s", rel)
	}
	// Nonblocking prevents a concurrent replacement with a FIFO from hanging.
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) {
		file.Close()
		return nil, nil, fmt.Errorf("file changed: %s", rel)
	}
	return file, info, nil
}

func findCover(dir string) string {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return ""
	}
	defer root.Close()
	candidates := []string{"cover.jpg", "cover.png", "cover.jpeg", "folder.jpg", "folder.png", "folder.jpeg"}
	for _, name := range candidates {
		file, _, err := openRegularFile(root, name)
		if err == nil {
			file.Close()
			return filepath.Join(dir, name)
		}
	}
	return ""
}

// -------- Handlers --------

func handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(struct {
		Version string `json:"version"`
		Channel string `json:"channel"`
	}{buildVersion, buildChannel}); err != nil {
		logEvent("errors", "encode version: %v", err)
	}
}

func handleLibraryBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var selected map[string]bool
	includeState := true
	includeLogs := false
	includeSettings := false
	includeHealth := r.URL.Query().Get("health") == "1"
	var profileArchive []byte
	if r.URL.Query().Get("profiles") == "1" {
		var err error
		profileArchive, err = encodeProfilesBackup(r.Header.Get("X-GameShelf-Backup-Key"))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}
	if r.URL.Query().Has("select") {
		includeState = r.URL.Query().Get("state") == "1"
		includeLogs = r.URL.Query().Get("logs") == "1"
		includeSettings = r.URL.Query().Get("settings") == "1"
		selected = make(map[string]bool)
		for _, id := range r.URL.Query()["cover"] {
			selected[id] = true
		}
		if !includeState && !includeLogs && !includeSettings && !includeHealth && len(profileArchive) == 0 && len(selected) == 0 {
			http.Error(w, "select at least one item", http.StatusBadRequest)
			return
		}
	}
	var preferences map[string]string
	if raw := r.Header.Get("X-GameShelf-Preferences"); raw != "" {
		if len(raw) > 8192 || json.Unmarshal([]byte(raw), &preferences) != nil || validatePreferences(preferences) != nil {
			http.Error(w, "invalid appearance preferences", http.StatusBadRequest)
			return
		}
	}
	file, size, err := prepareLibraryBackupWithHealth(includeState, includeLogs, includeSettings, selected, preferences, includeHealth, profileArchive)
	if err != nil {
		logEvent("errors", "library backup unavailable: %v", err)
		http.Error(w, "Library backup failed. No backup was downloaded. Check the container logs and try again.", http.StatusServiceUnavailable)
		return
	}
	defer func() {
		file.Close()
		os.Remove(file.Name())
	}()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="gameshelf-library-backup.zip"`)
	w.Header().Set("Content-Length", fmt.Sprint(size))
	if _, err := io.Copy(w, file); err != nil {
		logEvent("errors", "send library backup: %v", err)
		// Abort the connection rather than finish a truncated successful response.
		panic(http.ErrAbortHandler)
	}
}

// Stage a complete ZIP on disk, keeping memory usage independent of artwork size.
// Serialize with scans, title edits and uploads only until the snapshot is ready.
func prepareLibraryBackup() (*os.File, int64, error) {
	return prepareLibraryBackupSelection(true, nil)
}

func prepareLibraryBackupSelection(includeState bool, selected map[string]bool) (*os.File, int64, error) {
	return prepareLibraryBackupSelectionExtra(includeState, false, false, selected)
}

func prepareLibraryBackupSelectionExtra(includeState, includeLogs, includeSettings bool, selected map[string]bool, preferences ...map[string]string) (*os.File, int64, error) {
	var value map[string]string
	if len(preferences) > 0 { value = preferences[0] }
	return prepareLibraryBackupWithHealth(includeState, includeLogs, includeSettings, selected, value, false)
}
func prepareLibraryBackupWithHealth(includeState, includeLogs, includeSettings bool, selected map[string]bool, preferences map[string]string, includeHealth bool, profiles ...[]byte) (*os.File, int64, error) {
	refreshMu.Lock()
	defer refreshMu.Unlock()

	// /data is already writable in containers with a read-only root filesystem.
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, 0, err
	}
	file, err := os.CreateTemp(dataDir, ".library-backup-*.zip")
	if err != nil {
		return nil, 0, err
	}
	ready := false
	defer func() {
		if !ready {
			file.Close()
			os.Remove(file.Name())
		}
	}()
	if err := writeLibraryBackupWithHealth(file, includeState, includeLogs, includeSettings, selected, preferences, includeHealth, profiles...); err != nil {
		return nil, 0, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, 0, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, 0, err
	}
	ready = true
	return file, info.Size(), nil
}

// Use the same containment rules as cover serving while preparing backups.
func openUploadedCoverForBackup(dirName, coverPath string) (*os.File, error) {
	if coverPath != customCoverPath(dirName) && coverPath != legacyCustomCoverPath(dirName) {
		return nil, fmt.Errorf("unsupported uploaded cover path")
	}
	root, err := os.OpenRoot(dataDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	rel, err := filepath.Rel(dataDir, coverPath)
	if err != nil {
		return nil, err
	}
	file, _, err := openRegularFile(root, rel)
	return file, err
}

func openFolderCoverForBackup(entry gameEntry) (*os.File, error) {
	if entry.NetworkID!=""{return remoteCoverFile(context.Background(),&entry,remoteCoverName(&entry))}
	root, err := openGameRoot(&entry)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	rel, err := filepath.Rel(filepath.Join(entryRootDir(&entry), entry.DirName), entry.CoverPath)
	if err != nil {
		return nil, err
	}
	file, _, err := openRegularFile(root, rel)
	return file, err
}

// The caller serializes metadata and artwork changes with refreshMu.
func writeLibraryBackup(dst io.Writer) error {
	return writeLibraryBackupSelection(dst, true, nil)
}

func writeLibraryBackupSelection(dst io.Writer, includeState bool, selected map[string]bool) error {
	return writeLibraryBackupSelectionExtra(dst, includeState, false, false, selected)
}

func writeLibraryBackupSelectionExtra(dst io.Writer, includeState, includeLogs, includeSettings bool, selected map[string]bool, preferences ...map[string]string) error {
	var value map[string]string
	if len(preferences) > 0 { value = preferences[0] }
	return writeLibraryBackupWithHealth(dst, includeState, includeLogs, includeSettings, selected, value, false)
}
func writeLibraryBackupWithHealth(dst io.Writer, includeState, includeLogs, includeSettings bool, selected map[string]bool, preferences map[string]string, includeHealth bool, profiles ...[]byte) error {
	archive := zip.NewWriter(dst)
	var err error
	if len(profiles) > 0 && len(profiles[0]) > 0 {
		member, e := archive.Create("family-profiles.enc.json")
		if e != nil {
			return e
		}
		if _, e = member.Write(profiles[0]); e != nil {
			return e
		}
	}
	if includeState {
		state, readErr := readLibraryMetadata()
		if readErr != nil {
			return readErr
		}
		contents, marshalErr := json.MarshalIndent(state, "", "  ")
		if marshalErr != nil {
			return marshalErr
		}
		stateFile, createErr := archive.Create("library-state.json")
		err = createErr
		if err == nil {
			_, err = stateFile.Write(append(contents, '\n'))
		}
	}
	if err == nil && includeSettings {
		settingsMu.RLock()
		settings := configuredSettings
		settingsMu.RUnlock()
		if preferences != nil {
			settings.Preferences = preferences
		}
		if err := validatePreferences(settings.Preferences); err != nil {
			return err
		}
		contents, marshalErr := json.MarshalIndent(publicSettings(settings), "", "  ")
		if marshalErr != nil {
			err = marshalErr
		} else {
			member, createErr := archive.Create("server-settings.json")
			if createErr != nil {
				err = createErr
			} else {
				_, err = member.Write(append(contents, '\n'))
			}
		}
	}
	if err == nil && includeLogs {
		member, createErr := archive.Create("logs.txt")
		if createErr != nil {
			err = createErr
		} else {
			_, err = member.Write(logSnapshotForExport("Application logs included in library backup export"))
		}
	}
	if err == nil && includeHealth {
		contents, readErr := healthArchiveBytes()
		if readErr != nil {
			err = readErr
		} else {
			member, createErr := archive.Create("library-health.json")
			if createErr != nil {
				err = createErr
			} else {
				_, err = member.Write(contents)
			}
		}
	}
	gamesMu.RLock()
	covers := make([]gameEntry, 0)
	for id, entry := range gamesMap {
		if entry.Game.HasCover && entry.CoverPath != "" && entry.Game.CoverSource != "placeholder" && (selected == nil || selected[id]) {
			covers = append(covers, *entry)
		}
	}
	gamesMu.RUnlock()
	if err == nil {
		for _, entry := range covers {
			var file *os.File
			var openErr error
			coverKey := entryCoverKey(&entry)
			archiveName := path.Join("covers", coverKey, "cover.png")
			if entry.Game.CoverSource == "uploaded" {
				file, openErr = openUploadedCoverForBackup(coverKey, entry.CoverPath)
			} else {
				file, openErr = openFolderCoverForBackup(entry)
				archiveName = path.Join("folder-covers", coverKey, filepath.Base(entry.CoverPath))
			}
			if openErr != nil {
				err = fmt.Errorf("open cover for %q: %w", entry.DirName, openErr)
				break
			}
			member, copyErr := archive.Create(archiveName)
			if copyErr == nil {
				_, copyErr = io.Copy(member, file)
			}
			if closeErr := file.Close(); copyErr == nil {
				copyErr = closeErr
			}
			if copyErr != nil {
				err = fmt.Errorf("copy cover for %q: %w", entry.DirName, copyErr)
				break
			}
		}
	}
	if closeErr := archive.Close(); err == nil {
		err = closeErr
	}
	return err
}

func handleGameTitle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/game-title/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	var request struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request); err != nil {
		http.Error(w, "Invalid title request.", http.StatusBadRequest)
		return
	}
	if request.Title != "" && !validGameTitle(request.Title) {
		http.Error(w, "Title must be 1 to 120 characters without line breaks.", http.StatusBadRequest)
		return
	}
	refreshMu.Lock()
	defer refreshMu.Unlock()
	entry := getGameEntryByID(id)
	if entry == nil {
		http.NotFound(w, r)
		return
	}
	state, err := readLibraryMetadata()
	if err != nil {
		http.Error(w, "Library data is unavailable.", http.StatusServiceUnavailable)
		return
	}
	name := request.Title
	if name == "" || name == entry.DirName {
		delete(state.Titles, entry.Game.Path)
		name = entry.DirName
	} else {
		state.Titles[entry.Game.Path] = name
	}
	if err := writeLibraryMetadata(state); err != nil {
		logEvent("errors", "save game title: %v", err)
		http.Error(w, "Unable to save title.", http.StatusServiceUnavailable)
		return
	}
	gamesMu.Lock()
	if current := gamesMap[id]; current != nil && current.DirName == entry.DirName {
		updated := *current
		updated.Game.Name = name
		gamesMap[id] = &updated
	}
	gamesMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Name string `json:"name"`
	}{name})
}

func handleFavorite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/favorite/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	var payload struct {
		Favorite bool `json:"favorite"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&payload); err != nil {
		http.Error(w, "invalid favorite", http.StatusBadRequest)
		return
	}
	if saveProfileFavorite(w, r, id, payload.Favorite) {
		return
	}
	refreshMu.Lock()
	defer refreshMu.Unlock()
	entry := getGameEntryByID(id)
	if entry == nil {
		http.NotFound(w, r)
		return
	}
	state, err := readLibraryMetadata()
	if err != nil {
		http.Error(w, "library state unavailable", http.StatusServiceUnavailable)
		return
	}
	if payload.Favorite {
		state.Favorites[entry.Game.Path] = true
	} else {
		delete(state.Favorites, entry.Game.Path)
	}
	if err := writeLibraryMetadata(state); err != nil {
		http.Error(w, "could not save favorite", http.StatusServiceUnavailable)
		return
	}
	gamesMu.Lock()
	if current := gamesMap[id]; current != nil && current.DirName == entry.DirName {
		updated := *current
		updated.Game.Favorite = payload.Favorite
		gamesMap[id] = &updated
	}
	gamesMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

// Serve a supported image from the selected game through its confined root.
// The browser uses this only as an editor source; saving still writes a PNG to dataDir.
func handleCoverSource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	id := strings.TrimPrefix(r.URL.Path, "/api/cover-source/")
	entry := getGameEntryByID(id)
	rel := r.URL.Query().Get("path")
	ext := strings.ToLower(filepath.Ext(rel))
	if entry == nil || !filepath.IsLocal(rel) || rel == "." || strings.Contains(rel, "\\") || (ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".gif" && ext != ".webp") {
		http.NotFound(w, r); return
	}
	if entry.NetworkID!=""{serveNetworkCover(w,r,entry,rel,true);return}
	root, err := openGameRoot(entry)
	if err != nil { http.NotFound(w, r); return }
	defer root.Close()
	file, info, err := openRegularFile(root, rel)
	if err != nil || info.Size() > 20<<20 { if file != nil { file.Close() }; http.NotFound(w, r); return }
	defer file.Close()
	first := make([]byte, 512)
	n, err := file.Read(first)
	if err != nil && err != io.EOF { http.NotFound(w, r); return }
	contentType := http.DetectContentType(first[:n])
	if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/gif" && contentType != "image/webp" { http.NotFound(w, r); return }
	if _, err := file.Seek(0, io.SeekStart); err != nil { http.NotFound(w, r); return }
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func handleCoverUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("Content-Type") != "image/png" {
		http.Error(w, "Upload a PNG image.", http.StatusUnsupportedMediaType)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/covers/")
	entry := getGameEntryByID(id)
	if id == "" || entry == nil {
		http.NotFound(w, r)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if err != nil {
		http.Error(w, "Cover image is too large.", http.StatusRequestEntityTooLarge)
		return
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 {
		http.Error(w, "Invalid cover image.", http.StatusBadRequest)
		return
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		http.Error(w, "Invalid cover image.", http.StatusBadRequest)
		return
	}
	refreshMu.Lock()
	defer refreshMu.Unlock()
	coverPath := customCoverPath(entryCoverKey(entry))
	if err := os.MkdirAll(filepath.Dir(coverPath), 0700); err != nil {
		http.Error(w, "Unable to save cover image.", http.StatusServiceUnavailable)
		return
	}
	file, err := os.CreateTemp(filepath.Dir(coverPath), ".cover-*.tmp")
	if err != nil {
		http.Error(w, "Unable to save cover image.", http.StatusServiceUnavailable)
		return
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), coverPath)
	}
	if err != nil {
		logEvent("errors", "save cover for %s: %v", entry.Game.Name, err)
		http.Error(w, "Unable to save cover image.", http.StatusServiceUnavailable)
		return
	}
	gamesMu.Lock()
	if current := gamesMap[id]; current != nil && current.DirName == entry.DirName {
		updated := *current
		updated.CoverPath = coverPath
		updated.Game.HasCover = true
		updated.Game.CoverSource = "uploaded"
		gamesMap[id] = &updated
	}
	gamesMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func handleGames(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// forceRefresh enables client to bypass auto-scan timer
	if r.URL.Query().Has("forceRefresh") {
		if !admitManualRefresh(w, r) {
			return
		}
        // Release discovery admission as soon as the scan finishes. A slow
        // reader of the JSON response must not hold the manual-scan slot.
        err := func() error { defer finishManualRefresh(); return refreshGames() }()
		if err != nil {
			logEvent("errors", "forced scan error: %v", err)
			http.Error(w, "Unable to refresh game library. Please try again later.", http.StatusServiceUnavailable)
			return
		}
	}

	gamesMu.RLock()
	defer gamesMu.RUnlock()

	list := make([]Game, 0, len(gamesMap))
	for _, e := range gamesMap {
		if profileAllows(r, e) {
			list = append(list, profileGame(r, e))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(list); err != nil {
		logEvent("errors", "encode games: %v", err)
	}
}

// LibraryStats summarizes the last complete scan without exposing host paths.
// Counts include regular files (including cover files) under indexed folders.
type LibraryStats struct {
	GameCount        int    `json:"gameCount"`
	FileCount        int    `json:"fileCount"`
	TotalSizeBytes   int64  `json:"totalSizeBytes"`
	CoveredGameCount int    `json:"coveredGameCount"`
	LastIndexedAt    string `json:"lastIndexedAt"`
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	gamesMu.RLock()
	stats := LibraryStats{}
	if !lastIndexedAt.IsZero() {
		stats.LastIndexedAt = lastIndexedAt.Format(time.RFC3339)
	}
	for _, entry := range gamesMap {
		if !profileAllows(r, entry) {
			continue
		}
		stats.GameCount++
		stats.FileCount += entry.Game.FileCount
		stats.TotalSizeBytes += entry.Game.SizeBytes
		if entry.Game.HasCover {
			stats.CoveredGameCount++
		}
	}
	gamesMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		logEvent("errors", "encode stats: %v", err)
	}
}

type gameFile struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

func handleGameFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/game-files/")
	entry := getGameEntryByID(id)
	if id == "" || entry == nil {
		http.NotFound(w, r)
		return
	}

	if entry.NetworkID!=""{handleRemoteFiles(w,r,entry);return}
	dirPath := filepath.Join(entryRootDir(entry), entry.DirName)
	files := make([]gameFile, 0)
	const maxFiles = 2000
	truncated := false
	err := filepath.WalkDir(dirPath, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		// WalkDir does not follow directory links. Omit file links too so
		// this list only describes files physically inside the selected game.
		if !d.Type().IsRegular() {
			return nil
		}
		if len(files) == maxFiles {
			truncated = true
			return fs.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dirPath, path)
		if err != nil {
			return err
		}
		files = append(files, gameFile{Path: filepath.ToSlash(rel), SizeBytes: info.Size()})
		return nil
	})
	if err != nil {
		logEvent("errors", "list files for %s: %v", entry.Game.Name, err)
		http.Error(w, "Unable to list game files.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(struct {
		Files     []gameFile `json:"files"`
		Truncated bool       `json:"truncated"`
	}{files, truncated}); err != nil {
		logEvent("errors", "encode game files: %v", err)
	}
}

func handleGameFileDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/game-file/")
	entry := getGameEntryByID(id)
	rel := r.URL.Query().Get("path")
	if id == "" || entry == nil || !filepath.IsLocal(rel) || rel == "." || strings.Contains(rel, "\\") {
		http.NotFound(w, r)
		return
	}
	if entry.NetworkID!=""{serveRemoteFile(w,r,entry,rel);return}
	root, err := openGameRoot(entry)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	file, info, err := openRegularFile(root, rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	if logTypeEnabled("downloads") { log.Printf("[download] file %s/%s", entry.Game.ID, rel) }
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, sanitizeFilename(filepath.Base(rel))))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/download/")
	id = strings.TrimSpace(id)
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	entry := getGameEntryByID(id)
	if entry == nil {
		http.NotFound(w, r)
		return
	}

	if entry.NetworkID!=""{downloadRemoteGame(w,r,entry);return}
	root, err := openGameRoot(entry)
	if err != nil {
		http.Error(w, "Unable to read game directory.", http.StatusServiceUnavailable)
		return
	}
	defer root.Close()
	if logTypeEnabled("downloads") { log.Printf("[download] game %s", entry.Game.ID) }
	w.Header().Set("Content-Type", "application/zip")
	filename := fmt.Sprintf("%s.zip", sanitizeFilename(entry.Game.Name))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	output := &zipResponseWriter{ResponseWriter: w}
	if err := writeGameZIP(output, root); err != nil {
		logEvent("errors", "zip error for %s: %v", entry.Game.Name, err)
		if output.started {
			// Do not finalize a partial archive as a successful ZIP. net/http aborts
			// the connection (or HTTP/2 stream) without appending an error to ZIP data.
			panic(http.ErrAbortHandler)
		}
		w.Header().Del("Content-Disposition")
		w.Header().Del("Content-Type")
		http.Error(w, "Unable to download game files.", http.StatusServiceUnavailable)
	}
}

type zipResponseWriter struct {
	http.ResponseWriter
	started bool
}

func (w *zipResponseWriter) Write(p []byte) (int, error) {
	w.started = true
	return w.ResponseWriter.Write(p)
}

// Walk only descriptor-relative paths. Symlinks and special files are omitted;
// an entry that changes or becomes unreadable aborts the archive.
func writeGameZIP(dst io.Writer, root *os.Root) error {
	zw := zip.NewWriter(dst)
	if err := addGameToZIP(zw, root, ""); err != nil { return err }
	return zw.Close()
}

func addGameToZIP(zw *zip.Writer, root *os.Root, base string) error {
	var walk func(*os.Root, string) error
	walk = func(dir *os.Root, prefix string) error {
		listing, err := dir.Open(".")
		if err != nil {
			return err
		}
		entries, err := listing.ReadDir(-1)
		listing.Close()
		if err != nil {
			return err
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			name := entry.Name()
			rel := path.Join(prefix, name)
			if entry.IsDir() {
				child, err := openChildRoot(dir, name)
				if err != nil {
					return err
				}
				err = walk(child, rel)
				child.Close()
				if err != nil {
					return err
				}
			} else if entry.Type().IsRegular() {
				file, _, err := openRegularFile(dir, name)
				if err != nil {
					return err
				}
				fw, err := zw.Create(rel)
				if err == nil {
					_, err = io.Copy(fw, file)
				}
				closeErr := file.Close()
				if err != nil {
					return err
				}
				if closeErr != nil {
					return closeErr
				}
			}
		}
		return nil
	}
	if err := walk(root, base); err != nil {
		return err
	}
	return nil
}

func handleDownloadCart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	ids := r.URL.Query()["game"]
	if len(ids) == 0 || len(ids) > 50 { http.Error(w, "select 1 to 50 games", http.StatusBadRequest); return }
	type item struct { id string; root *os.Root; entry *gameEntry }
	items := make([]item, 0, len(ids))
	defer func() { for _, selected := range items { if selected.root!=nil{selected.root.Close()} } }()
	seen := make(map[string]bool)
	for _, id := range ids {
		if id == "" || seen[id] { http.Error(w, "invalid cart selection", http.StatusBadRequest); return }
		seen[id] = true
		entry := getGameEntryByID(id)
		if entry == nil { http.NotFound(w, r); return }
		if entry.NetworkID != "" {
			if rejectUnavailableNetwork(w, r, entry) { return }
			items = append(items, item{id, nil, entry})
			continue
		}
		root, err := openGameRoot(entry)
		if err != nil { http.Error(w, "Unable to read a selected game.", http.StatusServiceUnavailable); return }
		items = append(items, item{id, root,entry})
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="gameshelf-playlist.zip"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	output := &zipResponseWriter{ResponseWriter:w}
	archive := zip.NewWriter(output)
	for _, selected := range items {
		if logTypeEnabled("downloads") { log.Printf("[download] playlist game %s", selected.id) }
		var err error;if selected.entry.NetworkID!=""{err=addRemoteGameToZIP(r.Context(),archive,selected.entry,selected.id)}else{err=addGameToZIP(archive,selected.root,selected.id)}
		if err != nil {
			logEvent("errors", "playlist zip error: %v", err)
			if output.started { panic(http.ErrAbortHandler) }
			http.Error(w, "Unable to package selected games.", http.StatusServiceUnavailable)
			return
		}
	}
	if err := archive.Close(); err != nil { logEvent("errors", "playlist zip close: %v", err); panic(http.ErrAbortHandler) }
}

func handleCover(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id := strings.TrimPrefix(r.URL.Path, "/covers/")
	id = strings.TrimSpace(id)
	if id == "" {
		http.NotFound(w, r)
		return
	}

	entry := getGameEntryByID(id)
	if entry == nil {
		http.NotFound(w, r)
		return
	}

	if entry.CoverPath == "" {
		f, err := webFS.Open("web/placeholder.png")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()

		w.Header().Set("Content-Type", "image/png")
		io.Copy(w, f)
		return
	}

	if entry.NetworkID!=""&&entry.Game.CoverSource!="uploaded"{serveNetworkCover(w,r,entry,remoteCoverName(entry),false);return}
	var root *os.Root
	var rel string
	var err error
	if entry.Game.CoverSource == "uploaded" {
		// Only the two supported uploaded-cover locations are allowed.
		if entry.CoverPath != customCoverPath(entryCoverKey(entry)) && entry.CoverPath != legacyCustomCoverPath(entryCoverKey(entry)) {
			http.NotFound(w, r)
			return
		}
		root, err = os.OpenRoot(dataDir)
		if err == nil {
			rel, err = filepath.Rel(dataDir, entry.CoverPath)
		}
	} else {
		root, err = openGameRoot(entry)
		if err == nil {
			rel, err = filepath.Rel(filepath.Join(entryRootDir(entry), entry.DirName), entry.CoverPath)
		}
	}
	if root != nil {
		defer root.Close()
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	file, info, err := openRegularFile(root, rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func getGameEntryByID(id string) *gameEntry {
	gamesMu.RLock()
	defer gamesMu.RUnlock()
	return gamesMap[id]
}

func sanitizeFilename(name string) string {
	s := strings.TrimSpace(name)
	s = strings.NewReplacer("/", "-", "\\", "-", ":", "-", `"`, "'", "\r", "", "\n", "").Replace(s)
	return s
}

type serverSettings struct {
	Access *accessPolicy `json:"access,omitempty"`
	Health *healthOptions `json:"health,omitempty"`
	SetupCompleted bool `json:"setupCompleted,omitempty"`
 SetupStatus string `json:"setupStatus,omitempty"`
	Preferences map[string]string `json:"preferences,omitempty"`
	RootDir string `json:"rootDir"`
	RootDirs []string `json:"rootDirs,omitempty"`
	Sources []networkSource `json:"sources,omitempty"`
	DataDir string `json:"dataDir"`
	RefreshInterval string `json:"refreshInterval"`
	Verbose bool `json:"verbose"`
	LogOptions *logOptions `json:"logOptions,omitempty"`
}

func libraryRoots(settings serverSettings) []string {
	if len(settings.RootDirs) > 0 { return settings.RootDirs }
	if settings.RootDir == "" { return nil }
	return []string{settings.RootDir}
}

type logOptions struct {
	BaseConfigured bool `json:"baseConfigured,omitempty"`
	System bool `json:"system"`
	Library bool `json:"library"`
	Errors bool `json:"errors"`
 Health bool `json:"health"`
 HealthConfigured bool `json:"healthConfigured,omitempty"`
	Requests bool `json:"requests"`
	Scans bool `json:"scans"`
	Downloads bool `json:"downloads"`
	OverrideSize bool `json:"overrideSize"`
	SizeMB int `json:"sizeMB"`
	OverrideDays bool `json:"overrideDays"`
	Days int `json:"days"`
}

func defaultLogOptions() *logOptions { return &logOptions{BaseConfigured:true, System:true, Library:true, Errors:true, Health:true, Requests:true, Downloads:true, Scans:true, HealthConfigured:true, SizeMB:10, Days:0} }

func normalizeLogOptions(value *logOptions) *logOptions {
	if value == nil { return defaultLogOptions() }
	copy := *value
	if !copy.BaseConfigured { copy.System, copy.Library, copy.Errors, copy.Health = true, true, true, true; copy.BaseConfigured = true }
	if !copy.HealthConfigured {copy.Health=true;copy.HealthConfigured=true}
	if copy.SizeMB == 0 { copy.SizeMB = 10 }

	return &copy
}

func logTypeEnabled(kind string) bool {
	settingsMu.RLock(); options := normalizeLogOptions(configuredSettings.LogOptions); settingsMu.RUnlock()
	custom := verboseLogging.Load()
	switch kind {
	case "system": return !custom || options.System
	case "library": return !custom || options.Library
	case "errors": return !custom || options.Errors
 case "health": return !custom || options.Health
	case "requests": return custom && options.Requests
	case "scans": return custom && options.Scans
	case "downloads": return custom && options.Downloads
	}
	return false
}

func logEvent(kind, format string, args ...any) {
	if logTypeEnabled(kind) { log.Printf("["+kind+"] "+format, args...) }
}

var (
	settingsMu sync.RWMutex
	configuredSettings serverSettings
	settingsHome string
	allowedLibraryRoot string
	verboseLogging atomic.Bool
	applicationLogs boundedLog
)

// Keep a bounded log snapshot so exports do not depend on Docker log access.
type boundedLog struct {
	mu sync.Mutex
	data []byte
	limit int
	maxAge time.Duration
}

func (b *boundedLog) Configure(options *logOptions) {
	options = normalizeLogOptions(options)
	b.mu.Lock(); defer b.mu.Unlock()
	b.limit = 10 << 20
	if options.OverrideSize { b.limit = options.SizeMB << 20 }
	b.maxAge = 0
	if options.OverrideDays { b.maxAge = time.Duration(options.Days) * 24 * time.Hour }
	b.prune()
}

func (b *boundedLog) prune() {
	if b.limit <= 0 { b.limit = 10 << 20 }
		cutoff := time.Now().Add(-b.maxAge)
	lines := bytes.SplitAfter(b.data, []byte("\n"))
	first := 0
	for b.maxAge > 0 && first < len(lines) {
		line := lines[first]
		if len(line) < 19 { break }
		stamp, err := time.ParseInLocation("2006/01/02 15:04:05", string(line[:19]), time.Local)
		if err != nil || !stamp.Before(cutoff) { break }
		first++
	}
	if first > 0 { b.data = bytes.Join(lines[first:], nil) }
	if len(b.data) > b.limit {
		b.data = bytes.Clone(b.data[len(b.data)-b.limit:])
		if index := bytes.IndexByte(b.data, '\n'); index >= 0 { b.data = b.data[index+1:] }
	}
}

func (b *boundedLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	b.prune()
	return len(p), nil
}

func (b *boundedLog) Snapshot() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.prune()
	return bytes.Clone(b.data)
}

func defaultServerSettings() serverSettings {
	root := os.Getenv("GAMESHELF_ROOT")
	data := os.Getenv("GAMESHELF_DATA_DIR")
	if data == "" { data = "/data" }
	interval := os.Getenv("GAMESHELF_REFRESH_INTERVAL")
	if interval == "" { interval = "168h" }
	return serverSettings{RootDir: root, DataDir: data, RefreshInterval: interval, Verbose:true, LogOptions: defaultLogOptions()}
}

func settingsFile() string { return filepath.Join(settingsHome, "server-settings.json") }

func pathInside(base, candidate string) bool {
	baseAbs, err := filepath.EvalSymlinks(base)
	if err != nil { return false }
	candidateAbs, err := filepath.EvalSymlinks(candidate)
	if err != nil { return false }
	rel, err := filepath.Rel(baseAbs, candidateAbs)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func validRefreshInterval(value string) bool {
	if value == "0" { return true }
	duration, err := time.ParseDuration(value)
	return err == nil && duration > 0
}

func validateServerSettings(value serverSettings) error {
	if err := validateAccessPolicy(value.Access); err != nil { return err }
	if err := validateHealthOptions(value.Health); err != nil { return err }
	if err:=validatePreferences(value.Preferences);err!=nil{return err}
 if value.SetupStatus!="" && value.SetupStatus!="pending" && value.SetupStatus!="skipped" && value.SetupStatus!="complete" {return errors.New("invalid setup status")}
	if len(libraryRoots(value))+len(value.Sources)>16{return errors.New("choose up to 16 library sources")}
	ids,locations:=map[string]bool{},map[string]bool{}
	for _,source:=range value.Sources{normalized,err:=normalizeNetworkSource(source);if err!=nil{return err};if normalized.ID!=""&&ids[normalized.ID]{return errors.New("duplicate network source identifier")};if locations[normalized.URL]{return errors.New("this network location is already in the library")};ids[normalized.ID]=true;locations[normalized.URL]=true}
	if options := normalizeLogOptions(value.LogOptions); options.SizeMB < 1 || options.SizeMB > 100 || options.Days < 0 || options.Days > 3650 || (options.OverrideDays && options.Days < 1) { return errors.New("log retention must be 1–100 MB and 1–3650 days when enabled") }
	roots := libraryRoots(value)
	if len(roots) > 16 || (len(roots) > 0 && roots[0] != value.RootDir) { return errors.New("choose 1–16 library paths with the primary path first") }
	if !filepath.IsAbs(value.DataDir) || !filepath.IsLocal(filepath.Base(value.DataDir)) {
		return errors.New("paths must be absolute container paths")
	}
	if !pathInside(settingsHome, value.DataDir) {
		return errors.New("paths must stay within the configured library and data mounts")
	}
	if !validRefreshInterval(value.RefreshInterval) { return errors.New("refresh interval must be a positive number of hours or 0") }
	for i, directory := range roots {
		if !filepath.IsAbs(directory) || !filepath.IsLocal(filepath.Base(directory)) || !libraryPathAllowed(directory) { return errors.New("choose a folder inside a mounted library directory; add a Docker folder mapping if it is not available") }
		if pathInside(value.DataDir, directory) || pathInside(directory, value.DataDir) { return errors.New("keep game folders separate from GameShelf saved data") }
		if _, err := os.ReadDir(directory); err != nil { return fmt.Errorf("GameShelf cannot read the library folder: %s; check its mapping and permissions", directory) }
		for j := 0; j < i; j++ {
			// A secondary share can be mounted beneath the primary /games mount.
			if j == 0 && pathInside(roots[0], directory) && !pathInside(directory, roots[0]) { continue }
			if pathInside(roots[j], directory) || pathInside(directory, roots[j]) { return errors.New("library paths must not overlap except for a share beneath the primary path") }
		}
	}
	for _, directory := range append(append([]string(nil), roots...), value.DataDir) {
		info, err := os.Stat(directory)
		if err != nil || !info.IsDir() { return fmt.Errorf("directory is unavailable: %s", directory) }
	}
	return nil
}

func initializeServerSettings() serverSettings {
	defaults := defaultServerSettings()
	settingsHome = defaults.DataDir
	allowedLibraryRoot = defaults.RootDir
	mountedLibraryRoots = discoverLibraryMounts()
	setupRequired.Store(false)
	log.SetOutput(io.MultiWriter(os.Stdout, &applicationLogs))
	value := defaults
	contents, err := os.ReadFile(settingsFile())
	if err == nil {
		if jsonErr := json.Unmarshal(contents, &value); jsonErr != nil || validateServerSettings(value) != nil {
			logEvent("errors", "invalid saved server settings; using container defaults")
			value = defaults
		}
	} else if !os.IsNotExist(err) {
		logEvent("errors", "server settings unavailable: %v", err)
	}
	settingsMu.Lock()
	value.LogOptions = normalizeLogOptions(value.LogOptions)
	configuredSettings = value
	settingsMu.Unlock()
	verboseLogging.Store(value.Verbose)
	applicationLogs.Configure(value.LogOptions)
	setupRequired.Store(needsFirstSetup(value))
	return value
}

func saveServerSettings(value serverSettings) error {
	var secretsErr error;value,secretsErr=prepareNetworkSecrets(value);if secretsErr!=nil{return secretsErr}
	value.LogOptions = normalizeLogOptions(value.LogOptions)
	if err := validateServerSettings(value); err != nil { return err }
	contents, err := json.MarshalIndent(value, "", "  ")
	if err != nil { return err }
	file, err := os.CreateTemp(settingsHome, ".server-settings-*.tmp")
	if err != nil { return err }
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil { _, err = file.Write(append(contents, '\n')) }
	if err == nil { err = file.Sync() }
	if closeErr := file.Close(); err == nil { err = closeErr }
	if err != nil { return err }
	if err := os.Rename(file.Name(), settingsFile()); err != nil { return err }
	settingsMu.Lock()
	configuredSettings = value
	settingsMu.Unlock()
	verboseLogging.Store(value.Verbose)
	applicationLogs.Configure(value.LogOptions)
	return nil
}

func handleServerSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settingsMu.RLock()
		value := configuredSettings
		settingsMu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(profileSafeSettings(r, publicSettings(value)))
	case http.MethodPut:
		setupMu.Lock()
		defer setupMu.Unlock()
		var value serverSettings
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 524288))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&value); err != nil {
			http.Error(w, "invalid settings", http.StatusBadRequest)
			return
		}
		settingsMu.RLock()
		old := configuredSettings
		settingsMu.RUnlock()
		value.Access=publicAccessPolicy(old.Access)
		if !hasLibrary(value) && !value.SetupCompleted && !setupRequired.Load() {
			http.Error(w, "choose at least one library folder", http.StatusBadRequest)
			return
		}
		if err := saveServerSettings(value); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		settingsMu.RLock()
		saved := configuredSettings
		settingsMu.RUnlock()
		restart:=old.DataDir!=saved.DataDir
		libraryChanged:=old.RootDir!=saved.RootDir||strings.Join(libraryRoots(old),"\x00")!=strings.Join(libraryRoots(saved),"\x00")||!sourcesEqual(old.Sources,saved.Sources)
		if libraryChanged && !restart && !setupRequired.Load() {
			if err := activateLibrary(saved); err != nil {
				logEvent("errors", "library source scan: %v", err)
			}
		}
		if old.RefreshInterval != saved.RefreshInterval {
			notifyRefreshSchedule()
		}
 logServerSettingsChanges(old,saved)
	notifyHealthSchedule()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			RestartRequired bool           `json:"restartRequired"`
			Settings        serverSettings `json:"settings"`
		}{restart, publicSettings(saved)})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleResetServerSettings(w http.ResponseWriter, r *http.Request) { performGameOver(w,r) }

func handleLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Query().Get("export") == "1" {
		w.Write(logSnapshotForExport("Application logs exported"))
	} else {
		w.Write(applicationLogs.Snapshot())
	}
}

type metadataResetRequest struct {
	Title bool `json:"title"`
	Cover bool `json:"cover"`
	Favorite bool `json:"favorite"`
}

type stagedCover struct { original, staged string }

func stageUploadedCovers(dirName string) ([]stagedCover, error) {
	var moved []stagedCover
	for _, original := range []string{customCoverPath(dirName), legacyCustomCoverPath(dirName)} {
		info, err := os.Lstat(original)
		if os.IsNotExist(err) { continue }
		if err != nil || !info.Mode().IsRegular() { restoreStagedCovers(moved); return nil, fmt.Errorf("uploaded cover is unavailable") }
		tmp, err := os.CreateTemp(filepath.Dir(original), ".cover-reset-*.tmp")
		if err != nil { restoreStagedCovers(moved); return nil, err }
		staged := tmp.Name()
		tmp.Close()
		os.Remove(staged)
		if err := os.Rename(original, staged); err != nil { restoreStagedCovers(moved); return nil, err }
		moved = append(moved, stagedCover{original, staged})
	}
	return moved, nil
}

func restoreStagedCovers(covers []stagedCover) {
	for _, cover := range covers {
		if err := os.Rename(cover.staged, cover.original); err != nil { logEvent("errors", "restore cover after reset failure: %v", err) }
	}
}

func handleMetadataReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	id := strings.TrimPrefix(r.URL.Path, "/api/metadata-reset/")
	if id == "" { http.NotFound(w, r); return }
	var request metadataResetRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || (!request.Title && !request.Cover && !request.Favorite) {
		http.Error(w, "select metadata to reset", http.StatusBadRequest)
		return
	}
	refreshMu.Lock()
	defer refreshMu.Unlock()
	entry := getGameEntryByID(id)
	if entry == nil { http.NotFound(w, r); return }
	state, err := readLibraryMetadata()
	if err != nil { http.Error(w, "library state unavailable", http.StatusServiceUnavailable); return }
	var staged []stagedCover
	if request.Cover { delete(state.CoverStretch,entry.Game.Path)

		staged, err = stageUploadedCovers(entryCoverKey(entry))
		if err != nil { http.Error(w, "could not reset cover", http.StatusServiceUnavailable); return }
	}
	if request.Title { delete(state.Titles, entry.Game.Path) }
	if request.Favorite { delete(state.Favorites, entry.Game.Path) }
	if err := writeLibraryMetadata(state); err != nil {
		restoreStagedCovers(staged)
		http.Error(w, "could not save metadata reset", http.StatusServiceUnavailable)
		return
	}
	for _, cover := range staged { if err := os.Remove(cover.staged); err != nil { logEvent("errors", "remove reset cover: %v", err) } }
	updated := *entry
	if request.Title { updated.Game.Name = entry.DirName }
	if request.Favorite { updated.Game.Favorite = false }
 if request.Cover { updated.Game.CoverStretch=nil }
	if request.Cover {
		if entry.NetworkID!=""{relative:=remoteCoverName(entry);updated.CoverPath="";if relative!=""{updated.CoverPath=filepath.Join(entryRootDir(entry),entry.DirName,relative)}}else{updated.CoverPath = findCover(filepath.Join(entryRootDir(entry), entry.DirName))}
		updated.Game.HasCover = updated.CoverPath != ""
		updated.Game.CoverSource = "folder"
		if !updated.Game.HasCover { updated.Game.CoverSource = "placeholder" }
	}
	gamesMu.Lock()
	if current := gamesMap[id]; current != nil && current.DirName == entry.DirName { gamesMap[id] = &updated }
	gamesMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(updated.Game)
}

// A nil override follows the browser-wide preference; explicit false survives export.
func coverStretchOverride(state libraryState, key string) *bool {
	if value, ok := state.CoverStretch[key]; ok {
		return &value
	}
	return nil
}
func handleCoverFit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", 405)
		return
	}
	var payload struct {
		Stretch *bool `json:"stretch"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		http.Error(w, "invalid cover fit", 400)
		return
	}
	refreshMu.Lock()
	defer refreshMu.Unlock()
	id := strings.TrimPrefix(r.URL.Path, "/api/cover-fit/")
	entry := getGameEntryByID(id)
	if entry == nil {
		http.NotFound(w, r)
		return
	}
	state, err := readLibraryMetadata()
	if err != nil {
		http.Error(w, "library state unavailable", 503)
		return
	}
	if state.CoverStretch == nil {
		state.CoverStretch = make(map[string]bool)
	}
	if payload.Stretch == nil {
		delete(state.CoverStretch, entry.Game.Path)
	} else {
		state.CoverStretch[entry.Game.Path] = *payload.Stretch
	}
	if err = writeLibraryMetadata(state); err != nil {
		http.Error(w, "could not save cover fit", 503)
		return
	}
	gamesMu.Lock()
	if current := gamesMap[id]; current != nil {
		updated := *current
		updated.Game.CoverStretch = payload.Stretch
		gamesMap[id] = &updated
	}
	gamesMu.Unlock()
	logEvent("system", "Game cover fit changed: %s", id)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"coverStretch": payload.Stretch})
}
func handleSettingsEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	var preferences map[string]string
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&preferences); err != nil || validatePreferences(preferences) != nil || len(preferences) == 0 {
		http.Error(w, "invalid setting change", 400)
		return
	}
	if err := saveProfilePreferences(r, preferences); err != nil {
		http.Error(w, err.Error(), 409)
		return
	}
	keys := make([]string, 0, len(preferences))
	for key := range preferences {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		logEvent("system", "Display setting changed: %s=%s", key, preferences[key])
	}
	w.WriteHeader(http.StatusNoContent)
}
func logServerSettingsChanges(old, value serverSettings) {
	if !reflect.DeepEqual(normalizeHealthOptions(old.Health), normalizeHealthOptions(value.Health)) {
		logEvent("system", "Library health monitoring settings changed")
	}
	// Never log credential values, user names, or full network addresses.
	if !sourcesEqual(old.Sources, value.Sources) || strings.Join(libraryRoots(old), "\x00") != strings.Join(libraryRoots(value), "\x00") {
		logEvent("system", "Library locations updated (%d locations)", len(libraryRoots(value))+len(value.Sources))
	}
	if old.RefreshInterval != value.RefreshInterval {
		logEvent("system", "Refresh interval changed to %s", value.RefreshInterval)
	}
	if old.DataDir != value.DataDir {
		logEvent("system", "Saved data location changed; restart required")
	}
	oldLogs, _ := json.Marshal(old.LogOptions)
	newLogs, _ := json.Marshal(value.LogOptions)
	if old.Verbose != value.Verbose || !bytes.Equal(oldLogs, newLogs) {
		logEvent("system", "Logging configuration changed")
	}
}
