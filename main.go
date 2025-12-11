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
}

type gameEntry struct {
	Game      Game
	DirName   string // directory name on disk
	CoverPath string // absolute path to cover, if any
}

var (
	rootDir  string
	gamesMu  sync.RWMutex
	gamesMap = make(map[string]*gameEntry) // id -> entry
)

func main() {
	rootDir = os.Getenv("GAMESHELF_ROOT")
	if rootDir == "" {
		rootDir = "/games"
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
	mux.HandleFunc("/download/", handleDownload)
	mux.HandleFunc("/covers/", handleCover)

fileServer := http.FileServer(http.FS(sub))
mux.Handle("/", fileServer)


	// Static frontend
	sub, err := embedSubFS(webFS, "web")
	if err != nil {
		log.Fatalf("static FS error: %v", err)
	}
	// DEBUG: list everything inside the embedded "web" directory
	log.Println("DEBUG: Embedded files:")
	fs.WalkDir(sub, ".", func(path string, d fs.DirEntry, err error) error {
    	if err != nil {
        	log.Println("  [ERR]", err)
        	return nil
    	}
    	log.Println("  ", path)
    	return nil
	})

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
		log.Printf("invalid GAMESHELF_REFRESH_INTERVAL %q, using default 5m", value)
		return 12 * time.Hour
	}

	if dur <= 0 {
		return 0
	}

	return dur
}

// -------- Game indexing --------

func refreshGames() error {
    gamesMu.Lock()
    defer gamesMu.Unlock()

    gamesMap = make(map[string]*gameEntry)

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

        size, err := dirSize(absPath)
        if err != nil {
            log.Printf("warning: size for %s: %v", dirName, err)
        }

        cover := findCover(absPath)
        if cover == "" {
            // Future: auto-fetch cover via API service
            // cover = fetchCoverFromService(dirName)
        }

        entry := &gameEntry{
            Game: Game{
                ID:        id,
                Name:      dirName,
                SizeBytes: size,
                HasCover:  cover != "",
            },
            DirName:   dirName,
            CoverPath: cover,
        }

        gamesMap[id] = entry
    } // <-- THIS CLOSING BRACE WAS MISSING

    log.Printf("Indexed %d games", len(gamesMap))
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

func dirSize(root string) (int64, error) {
	var size int64
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
		return nil
	})
	return size, err
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

func handleGames(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodGet {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    // forceRefresh enables client to bypass auto-scan timer
    if r.URL.Query().Has("forceRefresh") {
        refreshGames()
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

    // If no cover found, serve placeholder instead of 404
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

    // Normal cover path
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