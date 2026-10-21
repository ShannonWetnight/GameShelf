package main

import (
	"archive/zip"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var webFS embed.FS

type Game struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	HasCover  bool   `json:"hasCover"`
	Path      string `json:"path"`
	FileCount int    `json:"fileCount"`
	AddedAt   string `json:"addedAt"`
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
	mux.HandleFunc("/api/version", handleVersion)
	mux.HandleFunc("/api/library-backup", handleLibraryBackup)
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
}

func readLibraryState() (map[string]string, error) {
	contents, err := os.ReadFile(filepath.Join(dataDir, "library-state.json"))
	if os.IsNotExist(err) {
		return make(map[string]string), nil
	}
	if err != nil {
		return nil, err
	}
	var state libraryState
	if err := json.Unmarshal(contents, &state); err != nil {
		return nil, err
	}
	if state.Version != 1 || state.FirstSeen == nil {
		return nil, fmt.Errorf("unsupported library state format")
	}
	for path, value := range state.FirstSeen {
		if path == "" || value == "" {
			return nil, fmt.Errorf("invalid library state entry")
		}
		if _, err := time.Parse(time.RFC3339, value); err != nil {
			return nil, fmt.Errorf("invalid date for %q: %w", path, err)
		}
	}
	return state.FirstSeen, nil
}

func writeLibraryState(firstSeen map[string]string) error {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return err
	}
	contents, err := json.MarshalIndent(libraryState{Version: 1, FirstSeen: firstSeen}, "", "  ")
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

func refreshGames() error {
	refreshMu.Lock()
	defer refreshMu.Unlock()

	nextGames := make(map[string]*gameEntry)
	firstSeen, stateErr := readLibraryState()
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

		cover := findCover(absPath)
		if cover == "" {
			// Future: auto-fetch cover via API service
			// cover = fetchCoverFromService(dirName)
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

		entry := &gameEntry{
			Game: Game{
				ID:        id,
				Name:      dirName,
				SizeBytes: size,
				HasCover:  cover != "",
				Path:      absPath,
				FileCount: fileCount,
				AddedAt:   addedAt,
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
			if err := writeLibraryState(nextFirstSeen); err != nil {
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

func findCover(dir string) string {
	candidates := []string{
		"cover.jpg", "cover.png", "cover.jpeg",
		"folder.jpg", "folder.png", "folder.jpeg",
	}
	for _, c := range candidates {
		p := filepath.Join(dir, c)
		if _, err := os.Stat(p); err == nil {
			return p
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
	firstSeen, err := readLibraryState()
	if err != nil {
		log.Printf("library backup unavailable: %v", err)
		http.Error(w, "Library backup is unavailable. Check the container logs.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="gameshelf-library-backup.json"`)
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(libraryState{Version: 1, FirstSeen: firstSeen}); err != nil {
		log.Printf("encode library backup: %v", err)
	}
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

	dirPath := filepath.Join(rootDir, entry.DirName)

	w.Header().Set("Content-Type", "application/zip")
	filename := fmt.Sprintf("%s.zip", sanitizeFilename(entry.Game.Name))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))

	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	err := filepath.WalkDir(dirPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		rel, err := filepath.Rel(dirPath, path)
		if err != nil {
			return err
		}

		fw, err := zipWriter.Create(rel)
		if err != nil {
			return err
		}

		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()

		if _, err := io.Copy(fw, file); err != nil {
			return err
		}
		return nil
	})

	if err != nil {
		log.Printf("zip error for %s: %v", entry.Game.Name, err)
	}
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

    http.ServeFile(w, r, entry.CoverPath)
}

func getGameEntryByID(id string) *gameEntry {
	gamesMu.RLock()
	defer gamesMu.RUnlock()
	return gamesMap[id]
}

func sanitizeFilename(name string) string {
	s := strings.TrimSpace(name)
	s = strings.ReplaceAll(s, "/", "-")
	s = strings.ReplaceAll(s, "\\", "-")
	s = strings.ReplaceAll(s, ":", "-")
	return s
}
