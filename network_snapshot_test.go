package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func snapshotFixture(t *testing.T) (networkSource, *bool) {
	t.Helper()
	setupFreshServer(t)
	oldList, oldSources := networkList, snapshotSources()
	oldIDs, oldRoot, oldData := cachedIDs, cachedIDRoot, cachedIDData
	t.Cleanup(func() {
		networkList = oldList
		setActiveSources(oldSources)
		cachedIDs, cachedIDRoot, cachedIDData = oldIDs, oldRoot, oldData
	})
	rootDir, rootDirs = "", nil
	source := networkSource{ID: newSourceID(), URL: "smb://nas/games", Protocol: "smb", Name: "NAS", Username: "private-user", Password: "private-password", PasswordCipher: "private-cipher"}
	setActiveSources([]networkSource{source})
	online := true
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) {
		if !online {
			return nil, errors.New("fixture disconnected")
		}
		return []remoteItem{{Path: "Game", IsDir: true}, {Path: "Game/game.bin", Size: 7, ModTime: "2026-10-25T01:00:00Z"}, {Path: "Game/cover.png", Size: 32}}, nil
	}
	return source, &online
}
func snapshotRestart() {
	gamesMap = make(map[string]*gameEntry)
	cachedIDs = nil
	cachedIDRoot = ""
	cachedIDData = ""
}
func snapshotOnlyGame(t *testing.T) *gameEntry {
	t.Helper()
	if len(gamesMap) != 1 {
		t.Fatalf("want one game, got %d", len(gamesMap))
	}
	for _, e := range gamesMap {
		return e
	}
	panic("unreachable")
}
func snapshotRefresh(t *testing.T) {
	t.Helper()
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
}

func TestNetworkOfflineRestartRestoresCatalog(t *testing.T) {
	_, online := snapshotFixture(t)
	snapshotRefresh(t)
	before := *snapshotOnlyGame(t)
	*online = false
	snapshotRestart()
	snapshotRefresh(t)
	after := snapshotOnlyGame(t)
	if after.Game.ID != before.Game.ID || after.Game.AddedAt != before.Game.AddedAt || after.CoverKey != before.CoverKey || !reflect.DeepEqual(after.RemoteFiles, before.RemoteFiles) {
		t.Fatalf("catalog changed: %#v / %#v", before, after)
	}
}

func TestNetworkSnapshotMetadataAndOfflineDownloads(t *testing.T) {
	_, online := snapshotFixture(t)
	snapshotRefresh(t)
	before := *snapshotOnlyGame(t)
	state, err := readLibraryMetadata()
	if err != nil {
		t.Fatal(err)
	}
	state.Titles[before.Game.Path] = "My title"
	state.Favorites[before.Game.Path] = true
	if err = writeLibraryMetadata(state); err != nil {
		t.Fatal(err)
	}
	cover := customCoverPath(before.CoverKey)
	if err = os.MkdirAll(filepath.Dir(cover), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(cover, []byte("uploaded-cover"), 0600); err != nil {
		t.Fatal(err)
	}
	*online = false
	snapshotRestart()
	snapshotRefresh(t)
	entry := snapshotOnlyGame(t)
	if !entry.Game.Unavailable || entry.Game.Name != "My title" || !entry.Game.Favorite || !entry.Game.IDPersisted || entry.Game.CoverSource != "uploaded" || entry.CoverPath != cover || entry.Game.AddedAt != before.Game.AddedAt {
		t.Fatalf("lost metadata: %#v", entry)
	}
	for _, test := range []struct {
		path    string
		handler func(*httptest.ResponseRecorder)
	}{
		{"ZIP", func(w *httptest.ResponseRecorder) {
			handleDownload(w, httptest.NewRequest("GET", "/download/"+entry.Game.ID, nil))
		}},
		{"file", func(w *httptest.ResponseRecorder) {
			handleGameFileDownload(w, httptest.NewRequest("GET", "/api/game-file/"+entry.Game.ID+"?path=game.bin", nil))
		}},
		{"Playlist", func(w *httptest.ResponseRecorder) {
			handleDownloadCart(w, httptest.NewRequest("GET", "/download-playlist?game="+entry.Game.ID, nil))
		}},
	} {
		w := httptest.NewRecorder()
		test.handler(w)
		if w.Code != 503 || !strings.Contains(w.Body.String(), "offline") || w.Header().Get("Content-Disposition") != "" {
			t.Fatalf("%s: %d %s", test.path, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	handleGameFiles(w, httptest.NewRequest("GET", "/api/game-files/"+entry.Game.ID, nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"unavailable":true`) || !strings.Contains(w.Body.String(), "game.bin") {
		t.Fatal(w.Code, w.Body.String())
	}
	contents, err := os.ReadFile(filepath.Join(dataDir, "network-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-user", "private-password", "private-cipher", "password", "username", "smb://"} {
		if strings.Contains(string(contents), secret) {
			t.Fatalf("snapshot leaked %q", secret)
		}
	}
	info, _ := os.Stat(filepath.Join(dataDir, "network-index.json"))
	if info.Mode().Perm() != 0600 {
		t.Fatalf("cache permissions %v", info.Mode())
	}
}

func TestNetworkSnapshotRecoveryReplacesAndEmptyScanClears(t *testing.T) {
	_, online := snapshotFixture(t)
	snapshotRefresh(t)
	before := snapshotOnlyGame(t).Game
	*online = false
	snapshotRestart()
	snapshotRefresh(t)
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) {
		return []remoteItem{{Path: "Game", IsDir: true}, {Path: "Game/new.bin", Size: 90}}, nil
	}
	snapshotRefresh(t)
	after := snapshotOnlyGame(t)
	if after.Game.Unavailable || after.Game.ID != before.ID || after.Game.AddedAt != before.AddedAt || after.Game.SizeBytes != 90 || len(after.RemoteFiles) != 1 || after.RemoteFiles[0].Path != "new.bin" {
		t.Fatal(after)
	}
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) { return nil, errors.New("offline") }
	snapshotRestart()
	snapshotRefresh(t)
	if snapshotOnlyGame(t).Game.SizeBytes != 90 {
		t.Fatal("stale cache overwrote successful scan")
	}
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) { return nil, nil }
	snapshotRefresh(t)
	if len(gamesMap) != 0 {
		t.Fatal("empty online source resurrected games")
	}
	snapshotRestart()
	networkList = func(context.Context, networkSource, bool) ([]remoteItem, error) { return nil, errors.New("offline") }
	_ = refreshGames()
	if len(gamesMap) != 0 {
		t.Fatal("empty snapshot resurrected games")
	}
}

func TestNetworkSnapshotRemovedOrChangedSources(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "removed", true: "edited"}[changed], func(t *testing.T) {
			source, online := snapshotFixture(t)
			snapshotRefresh(t)
			*online = false
			value := serverSettings{}
			if changed {
				source.URL = "smb://different/games"
				value.Sources = []networkSource{source}
			}
			_ = activateLibrary(value)
			if len(gamesMap) != 0 {
				t.Fatal("old source still visible")
			}
			snapshotRestart()
			_ = refreshGames()
			if len(gamesMap) != 0 {
				t.Fatal("removed source returned after restart")
			}
			// Reintroducing a removed location must not recover its pruned snapshot.
			source.URL = "smb://nas/games"
			setActiveSources([]networkSource{source})
			_ = refreshGames()
			if len(gamesMap) != 0 {
				t.Fatal("pruned cache returned")
			}
		})
	}
}

func TestNetworkSnapshotCorruptionAndWriteFailureAreNonfatal(t *testing.T) {
	for _, mode := range []string{"json", "version", "traversal", "oversize", "unwritable", "missing-data"} {
		t.Run(mode, func(t *testing.T) {
			_, online := snapshotFixture(t)
			snapshotRefresh(t)
			filename := filepath.Join(dataDir, "network-index.json")
			switch mode {
			case "json":
				os.WriteFile(filename, []byte("{"), 0600)
			case "version":
				os.WriteFile(filename, []byte(`{"version":99,"sources":{}}`), 0600)
			case "traversal":
				cached, err := readNetworkSnapshot()
				if err != nil {
					t.Fatal(err)
				}
				for id, s := range cached.Sources {
					s.Games[0].Files[0].Path = "../escape"
					cached.Sources[id] = s
				}
				content, _ := json.Marshal(cached)
				os.WriteFile(filename, content, 0600)
			case "oversize":
				f, err := os.OpenFile(filename, os.O_WRONLY|os.O_TRUNC, 0600)
				if err != nil {
					t.Fatal(err)
				}
				f.Truncate(networkSnapshotLimit + 1)
				f.Close()
			case "unwritable":
				os.Remove(filename)
				os.Mkdir(filename, 0700)
			case "missing-data":
				os.RemoveAll(dataDir)
				os.WriteFile(dataDir, []byte("not a directory"), 0600)
			}
			// Existing RAM index survives cache failures and an offline scan.
			*online = false
			snapshotRefresh(t)
			if !snapshotOnlyGame(t).Game.Unavailable {
				t.Fatal("offline status missing")
			}
			// The in-memory index may repair a writable corrupt cache. Corrupt it
			// again before cold startup to exercise the read failure itself.
			if mode == "json" || mode == "version" || mode == "traversal" || mode == "oversize" {
				if err := os.WriteFile(filename, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			// After restart, invalid caches cannot supply entries; live recovery works.
			snapshotRestart()
			_ = refreshGames()
			if len(gamesMap) != 0 {
				t.Fatal("invalid cache loaded")
			}
			*online = true
			snapshotRefresh(t)
			if snapshotOnlyGame(t).Game.Unavailable {
				t.Fatal("cache failure blocked live indexing")
			}
		})
	}
}

func TestNetworkSnapshotReservesIDsAcrossSources(t *testing.T) {
	first, online := snapshotFixture(t)
	snapshotRefresh(t)
	id := snapshotOnlyGame(t).Game.ID
	second := first
	second.ID = newSourceID()
	second.URL = "smb://second/games"
	setActiveSources([]networkSource{second, first})
	*online = false
	snapshotRestart()
	networkList = func(_ context.Context, s networkSource, _ bool) ([]remoteItem, error) {
		if s.ID == first.ID {
			return nil, errors.New("offline")
		}
		return []remoteItem{{Path: "Game", IsDir: true}}, nil
	}
	snapshotRefresh(t)
	if len(gamesMap) != 2 || gamesMap[id] == nil || gamesMap[id].NetworkID != first.ID {
		t.Fatal("fresh source overwrote offline ID", gamesMap)
	}
}

func TestNetworkSnapshotReadOnlyStorageKeepsLastSavedCatalog(t *testing.T) {
	_, online := snapshotFixture(t)
	snapshotRefresh(t)
	before := snapshotOnlyGame(t).Game
	filename := filepath.Join(dataDir, "network-index.json")
	contents, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(dataDir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dataDir, 0700) })
	*online = false
	snapshotRestart()
	snapshotRefresh(t)
	after := snapshotOnlyGame(t).Game
	if after.ID != before.ID || after.AddedAt != before.AddedAt || !after.Unavailable {
		t.Fatal(after)
	}
	saved, err := os.ReadFile(filename)
	if err != nil || string(saved) != string(contents) {
		t.Fatal("failed write damaged last snapshot", err)
	}
}
