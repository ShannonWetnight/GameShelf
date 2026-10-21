package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

//go:embed web/*
var webFS embed.FS

type Game struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	SizeBytes   int64  `json:"sizeBytes"`
	HasCover    bool   `json:"hasCover"`
	CoverSource string `json:"coverSource"`
	Path        string `json:"path"`
	FileCount   int    `json:"fileCount"`
	AddedAt     string `json:"addedAt"`
}

type gameEntry struct {
	Game      Game
	DirName   string // directory name on disk
	CoverPath string // absolute path to cover, if any
}

var (
	rootDir   string
	dataDir   string
	gamesMu   sync.RWMutex
	refreshMu sync.Mutex                   // serialize scans without blocking readers
	gamesMap  = make(map[string]*gameEntry) // id -> entry
	buildVersion = "Development"
	buildChannel = "development"
)

func main() {
	rootDir = os.Getenv("GAMESHELF_ROOT")
	if rootDir == "" {
		rootDir = "/games"
	}
	dataDir = os.Getenv("GAMESHELF_DATA_DIR")
	if dataDir == "" {
		dataDir = "/data"
	}

	if err := refreshGames(); err != nil {
		log.Fatalf("scan error: %v", err)
	}

	if interval := refreshInterval(); interval > 0 {
		log.Printf("Auto-rescanning every %s", interval)
		go func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()

			for range ticker.C {
				if err := refreshGames(); err != nil {
					log.Printf("periodic scan error: %v", err)
				}
			}
		}()
	} else {
		log.Print("Auto-rescan disabled")
	}

	mux := http.NewServeMux()

	// API endpoints
	mux.HandleFunc("/api/games", handleGames)
	mux.HandleFunc("/api/game-files/", handleGameFiles)
	mux.HandleFunc("/api/game-file/", handleGameFileDownload)
	mux.HandleFunc("/api/version", handleVersion)
	mux.HandleFunc("/api/library-backup", handleLibraryBackup)
	mux.HandleFunc("/api/covers/", handleCoverUpload)
	mux.HandleFunc("/api/game-title/", handleGameTitle)
	mux.HandleFunc("/download/", handleDownload)
	mux.HandleFunc("/covers/", handleCover)

	// Static frontend
	sub, err := embedSubFS(webFS, "web")
	if err != nil {
		log.Fatalf("static FS error: %v", err)
	}

	fileServer := http.FileServer(http.FS(sub))
	mux.Handle("/", fileServer)

	addr := ":8080"
	if v := os.Getenv("GAMESHELF_ADDR"); v != "" {
		addr = v
	}

	log.Printf("GameShelf serving %s on %s", rootDir, addr)
	if err := http.ListenAndServe(addr, loggingMiddleware(mux)); err != nil {
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
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}

func refreshInterval() time.Duration {
	value := os.Getenv("GAMESHELF_REFRESH_INTERVAL")
	if value == "" {
		return 12 * time.Hour
	}

	dur, err := time.ParseDuration(value)
	if err != nil {
		log.Printf("invalid GAMESHELF_REFRESH_INTERVAL %q, using default 12h", value)
		return 12 * time.Hour
	}

	if dur <= 0 {
		return 0
	}

	return dur
}

// -------- Game indexing --------

// libraryState stores only the first time GameShelf indexed each folder. It
// lives outside GAMESHELF_ROOT so the game library can remain read-only.
type libraryState struct {
	Version   int               `json:"version"`
	FirstSeen map[string]string `json:"firstSeen"`
	Titles    map[string]string `json:"titles,omitempty"`
}

func readLibraryMetadata() (libraryState, error) {
	contents, err := os.ReadFile(filepath.Join(dataDir, "library-state.json"))
	if os.IsNotExist(err) {
		return libraryState{Version: 1, FirstSeen: make(map[string]string), Titles: make(map[string]string)}, nil
	}
	if err != nil {
		return libraryState{}, err
	}
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
	for path, title := range state.Titles {
		if path == "" || !validGameTitle(title) {
			return libraryState{}, fmt.Errorf("invalid title for %q", path)
		}
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

func legacyCustomCoverPath(dirName string) string {
	hash := sha256.Sum256([]byte(dirName))
	return filepath.Join(dataDir, "covers", fmt.Sprintf("%x.png", hash))
}

func refreshGames() error {
	refreshMu.Lock()
	defer refreshMu.Unlock()

	nextGames := make(map[string]*gameEntry)
	state, stateErr := readLibraryMetadata()
	firstSeen := state.FirstSeen
	if stateErr != nil {
		log.Printf("Date-added state unavailable: %v", stateErr)
	}
	nextFirstSeen := make(map[string]string)
	stateChanged := false

	entries, err := os.ReadDir(rootDir)
	if err != nil {
		return fmt.Errorf("reading rootDir: %w", err)
	}

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}

		dirName := e.Name()
		id := slugify(dirName)
		absPath := filepath.Join(rootDir, dirName)

		size, fileCount, err := dirStats(absPath)
		if err != nil {
			return fmt.Errorf("scanning game %q: %w", dirName, err)
		}

		cover := customCoverPath(dirName)
		coverSource := "uploaded"
		if info, err := os.Lstat(cover); err != nil || !info.Mode().IsRegular() {
			cover = legacyCustomCoverPath(dirName)
			if info, err := os.Lstat(cover); err != nil || !info.Mode().IsRegular() {
				cover = findCover(absPath)
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
			},
			DirName:   dirName,
			CoverPath: cover,
		}

		nextGames[id] = entry
	}
	if stateErr == nil {
		if len(nextFirstSeen) != len(firstSeen) {
			stateChanged = true
		}
		if stateChanged {
			state.FirstSeen = nextFirstSeen
			if err := writeLibraryMetadata(state); err != nil {
				log.Printf("Date-added state could not be saved: %v", err)
				for _, entry := range nextGames {
					if firstSeen[entry.Game.Path] == "" {
						entry.Game.AddedAt = ""
					}
				}
			}
		}
	}

	// Publish only a complete scan; readers keep the last successful index.
	gamesMu.Lock()
	gamesMap = nextGames
	gamesMu.Unlock()

	log.Printf("Indexed %d games", len(nextGames))
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
	if !filepath.IsLocal(entry.DirName) || filepath.Base(entry.DirName) != entry.DirName {
		return nil, fmt.Errorf("invalid game directory")
	}
	library, err := os.OpenRoot(rootDir)
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
		log.Printf("encode version: %v", err)
	}
}

func handleLibraryBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	state, err := readLibraryMetadata()
	if err != nil {
		log.Printf("library backup unavailable: %v", err)
		http.Error(w, "Library backup is unavailable. Check the container logs.", http.StatusServiceUnavailable)
		return
	}
	contents, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		http.Error(w, "Library backup is unavailable.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="gameshelf-library-backup.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	archive := zip.NewWriter(w)
	stateFile, err := archive.Create("library-state.json")
	if err == nil {
		_, err = stateFile.Write(append(contents, '\n'))
	}
	gamesMu.RLock()
	customCovers := make(map[string]string)
	for _, entry := range gamesMap {
		if entry.Game.CoverSource == "uploaded" {
			customCovers[entry.DirName] = entry.CoverPath
		}
	}
	gamesMu.RUnlock()
	if err == nil {
		for dirName, coverPath := range customCovers {
			file, openErr := os.Open(coverPath)
			if openErr != nil {
				err = openErr
				break
			}
			member, createErr := archive.Create(path.Join("covers", dirName, "cover.png"))
			if createErr == nil {
				_, createErr = io.Copy(member, file)
			}
			file.Close()
			if createErr != nil {
				err = createErr
				break
			}
		}
	}
	if closeErr := archive.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		log.Printf("write library backup: %v", err)
	}
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
		log.Printf("save game title: %v", err)
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
	coverPath := customCoverPath(entry.DirName)
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
		log.Printf("save cover for %s: %v", entry.Game.Name, err)
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
		if err := refreshGames(); err != nil {
			log.Printf("forced scan error: %v", err)
			http.Error(w, "Unable to refresh game library. Please try again later.", http.StatusServiceUnavailable)
			return
		}
	}

	gamesMu.RLock()
	defer gamesMu.RUnlock()

	list := make([]Game, 0, len(gamesMap))
	for _, e := range gamesMap {
		list = append(list, e.Game)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(list); err != nil {
		log.Printf("encode games: %v", err)
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

	dirPath := filepath.Join(rootDir, entry.DirName)
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
		log.Printf("list files for %s: %v", entry.Game.Name, err)
		http.Error(w, "Unable to list game files.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(struct {
		Files     []gameFile `json:"files"`
		Truncated bool       `json:"truncated"`
	}{files, truncated}); err != nil {
		log.Printf("encode game files: %v", err)
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

	root, err := openGameRoot(entry)
	if err != nil {
		http.Error(w, "Unable to read game directory.", http.StatusServiceUnavailable)
		return
	}
	defer root.Close()
	w.Header().Set("Content-Type", "application/zip")
	filename := fmt.Sprintf("%s.zip", sanitizeFilename(entry.Game.Name))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	output := &zipResponseWriter{ResponseWriter: w}
	if err := writeGameZIP(output, root); err != nil {
		log.Printf("zip error for %s: %v", entry.Game.Name, err)
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
	if err := walk(root, ""); err != nil {
		return err
	}
	return zw.Close()
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

	var root *os.Root
	var rel string
	var err error
	if entry.Game.CoverSource == "uploaded" {
		// Only the two supported uploaded-cover locations are allowed.
		if entry.CoverPath != customCoverPath(entry.DirName) && entry.CoverPath != legacyCustomCoverPath(entry.DirName) {
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
			rel, err = filepath.Rel(filepath.Join(rootDir, entry.DirName), entry.CoverPath)
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
