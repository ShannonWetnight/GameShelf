package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// Tests share the production globals and deliberately do not run in parallel.
func setupLibrary(t *testing.T) string {
	t.Helper()
	previousRoot, previousGames := rootDir, gamesMap
	t.Cleanup(func() { rootDir, gamesMap = previousRoot, previousGames })
	rootDir = t.TempDir()
	gamesMap = make(map[string]*gameEntry)
	return rootDir
}

func writeGame(t *testing.T, name string) {
	t.Helper()
	dir := filepath.Join(rootDir, name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "game.txt"), []byte("game data"), 0644); err != nil {
		t.Fatal(err)
	}
}

func requestGames(t *testing.T, path string, status int) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	handleGames(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != status {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, status, w.Body.String())
	}
	return w
}

func decodeGames(t *testing.T, w *httptest.ResponseRecorder) []Game {
	t.Helper()
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	var games []Game
	if err := json.Unmarshal(w.Body.Bytes(), &games); err != nil {
		t.Fatal(err)
	}
	return games
}

func TestRefreshGamesReadDirFailurePreservesIndex(t *testing.T) {
	for _, kind := range []string{"missing", "file"} {
		t.Run(kind, func(t *testing.T) {
			root := setupLibrary(t)
			writeGame(t, "Existing Game")
			if err := refreshGames(); err != nil {
				t.Fatal(err)
			}
			before := getGameEntryByID("existing-game")
			rootDir = filepath.Join(root, "unavailable")
			if kind == "file" {
				if err := os.WriteFile(rootDir, nil, 0644); err != nil {
					t.Fatal(err)
				}
			}
			err := refreshGames()
			var pathErr *os.PathError
			if !errors.As(err, &pathErr) {
				t.Fatalf("expected wrapped filesystem error, got %v", err)
			}
			if len(gamesMap) != 1 || getGameEntryByID("existing-game") != before {
				t.Fatal("failed scan replaced existing index")
			}
			games := decodeGames(t, requestGames(t, "/api/games", http.StatusOK))
			if !reflect.DeepEqual(games, []Game{before.Game}) {
				t.Fatalf("cached response = %#v", games)
			}
		})
	}
}

func TestRefreshGamesSuccessfulRescans(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Old Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(rootDir, "Old Game")); err != nil {
		t.Fatal(err)
	}
	writeGame(t, "New Game")
	if err := os.WriteFile(filepath.Join(rootDir, "New Game", "cover.png"), []byte("cover"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	entry := getGameEntryByID("new-game")
	if len(gamesMap) != 1 || getGameEntryByID("old-game") != nil || entry == nil {
		t.Fatal("rescan did not replace index")
	}
	if entry.Game.Name != "New Game" || entry.Game.SizeBytes != 14 || !entry.Game.HasCover || entry.CoverPath != filepath.Join(rootDir, "New Game", "cover.png") {
		t.Fatalf("entry = %#v", entry)
	}
	if err := os.RemoveAll(filepath.Join(rootDir, "New Game")); err != nil {
		t.Fatal(err)
	}
	w := requestGames(t, "/api/games?forceRefresh=1", http.StatusOK)
	if w.Body.String() != "[]\n" {
		t.Fatalf("empty library = %q", w.Body.String())
	}
}

func TestHandleGamesForcedRefreshFailureAndRecovery(t *testing.T) {
	root := setupLibrary(t)
	writeGame(t, "Existing Game")
	initial := decodeGames(t, requestGames(t, "/api/games?forceRefresh=1", http.StatusOK))
	unavailable := root + "-offline"
	if err := os.Rename(root, unavailable); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(unavailable, root) })
	for i := 0; i < 2; i++ {
		w := requestGames(t, "/api/games?forceRefresh=1", http.StatusServiceUnavailable)
		if !strings.Contains(w.Body.String(), "Unable to refresh game library") || strings.Contains(w.Body.String(), root) {
			t.Fatalf("error body = %q", w.Body.String())
		}
		if got := decodeGames(t, requestGames(t, "/api/games", http.StatusOK)); !reflect.DeepEqual(got, initial) {
			t.Fatalf("lost cached library: %#v", got)
		}
	}
	if err := os.Rename(unavailable, root); err != nil {
		t.Fatal(err)
	}
	writeGame(t, "Added Game")
	if got := decodeGames(t, requestGames(t, "/api/games?forceRefresh=1", http.StatusOK)); len(got) != 2 {
		t.Fatalf("recovered library = %#v", got)
	}
}

func TestHandleGamesRejectsOtherMethods(t *testing.T) {
	setupLibrary(t)
	rootDir = filepath.Join(rootDir, "missing")
	w := httptest.NewRecorder()
	handleGames(w, httptest.NewRequest(http.MethodPost, "/api/games?forceRefresh=1", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestConcurrentRefreshesAndReads(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Existing Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := refreshGames(); err != nil {
				t.Error(err)
			}
			w := httptest.NewRecorder()
			handleGames(w, httptest.NewRequest(http.MethodGet, "/api/games", nil))
			var games []Game
			if err := json.Unmarshal(w.Body.Bytes(), &games); err != nil || w.Code != http.StatusOK || len(games) != 1 {
				t.Errorf("incomplete response: %s (%v)", w.Body.String(), err)
			}
		}()
	}
	wg.Wait()
}

func TestRefreshGamesChildReadFailurePreservesWholeIndex(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Existing Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	before := getGameEntryByID("existing-game")
	writeGame(t, "A New Game")
	writeGame(t, "Z Unreadable Game")
	blocked := filepath.Join(rootDir, "Z Unreadable Game")
	if err := os.Chmod(blocked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0755) })
	if _, err := os.ReadDir(blocked); err == nil {
		t.Skip("current user can read directories without permission; covered by Docker smoke test with DAC capabilities dropped")
	}
	if err := refreshGames(); err == nil {
		t.Fatal("expected child scan error")
	}
	if len(gamesMap) != 1 || getGameEntryByID("existing-game") != before {
		t.Fatal("failed child scan published a partial index")
	}
}
