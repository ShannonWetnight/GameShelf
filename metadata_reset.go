package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

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
		if err := os.Rename(cover.staged, cover.original); err != nil { log.Printf("restore cover after reset failure: %v", err) }
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
	if request.Cover {
		staged, err = stageUploadedCovers(entry.DirName)
		if err != nil { http.Error(w, "could not reset cover", http.StatusServiceUnavailable); return }
	}
	if request.Title { delete(state.Titles, entry.Game.Path) }
	if request.Favorite { delete(state.Favorites, entry.Game.Path) }
	if err := writeLibraryMetadata(state); err != nil {
		restoreStagedCovers(staged)
		http.Error(w, "could not save metadata reset", http.StatusServiceUnavailable)
		return
	}
	for _, cover := range staged { if err := os.Remove(cover.staged); err != nil { log.Printf("remove reset cover: %v", err) } }
	updated := *entry
	if request.Title { updated.Game.Name = entry.DirName }
	if request.Favorite { updated.Game.Favorite = false }
	if request.Cover {
		updated.CoverPath = findCover(filepath.Join(rootDir, entry.DirName))
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
