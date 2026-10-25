package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHealthTransitionsPersistenceAndReadOnlyCache(t *testing.T) {
	root, data := setupFreshServer(t)
	rootDir, rootDirs = root, []string{root}
	writeGame(t, "Healthy Game")
	if err := refreshGames(); err != nil {
		t.Fatal(err)
	}
	resetHealthCache()
	runHealthCheck()
	snapshot := healthSnapshot()
	if len(snapshot.Sources) != 1 || snapshot.Sources[0].State != "healthy" || snapshot.Sources[0].Games != 1 {
		t.Fatalf("healthy: %#v", snapshot)
	}
	success := snapshot.Sources[0].LastSuccess
	if err := os.Rename(root, root+"-offline"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Rename(root+"-offline", root) })
	for i, want := range []string{"degraded", "degraded", "critical"} {
		runHealthCheck()
		snapshot = healthSnapshot()
		source := snapshot.Sources[0]
		if source.State != want || source.ConsecutiveFailures != i+1 || source.LastSuccess != success || source.Games != 1 {
			t.Fatalf("offline: %#v", source)
		}
	}
	gamesMu.RLock()
	count := len(gamesMap)
	gamesMu.RUnlock()
	if count != 1 {
		t.Fatal("health check removed cached games")
	}
	if err := os.Rename(root+"-offline", root); err != nil {
		t.Fatal(err)
	}
	runHealthCheck()
	snapshot = healthSnapshot()
	if snapshot.Sources[0].State != "healthy" || snapshot.Sources[0].ConsecutiveFailures != 0 {
		t.Fatal("reconnect failed")
	}
	if _, err := os.Stat(filepath.Join(data, "library-health.json")); err != nil {
		t.Fatal(err)
	}
	resetHealthCache()
	reloaded := healthSnapshot()
	if len(reloaded.Events) != 5 || reloaded.Sources[0].State != "healthy" {
		t.Fatal("history did not persist", reloaded)
	}
	// A new location is not reported healthy on the basis of the old location.
	rootDir, rootDirs = root+"-missing", []string{root + "-missing"}
	runHealthCheck()
	if healthSnapshot().Sources[0].State != "critical" {
		t.Fatal("new missing location needs critical state")
	}
}
func TestHealthProbeTimeoutIsBoundedAndDeduplicated(t *testing.T) {
	setupFreshServer(t)
	originalRead, originalTimeout := healthReadDir, healthProbeTimeout
	defer func() { healthReadDir, healthProbeTimeout = originalRead, originalTimeout }()
	release := make(chan struct{})
	var calls atomic.Int32
	healthReadDir = func(string) ([]os.DirEntry, error) { calls.Add(1); <-release; return nil, errors.New("unavailable") }
	healthProbeTimeout = 5 * time.Millisecond
	for i := 0; i < 4; i++ {
		if _, err := localHealthList("test-blocked-mount"); err == nil {
			t.Fatal("missing timeout")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("blocked probes accumulated", calls.Load())
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for {
		localHealthMu.Lock()
		remaining := len(localHealthProbes)
		localHealthMu.Unlock()
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("probe not released")
		}
		time.Sleep(time.Millisecond)
	}
	healthReadDir, healthProbeTimeout = originalRead, originalTimeout
}
func TestHealthNetworkErrorsAreSanitizedAndStatusAggregated(t *testing.T) {
	setupFreshServer(t)
	rootDir = ""
	rootDirs = nil
	old := snapshotSources()
	defer setActiveSources(old)
	source := networkSource{ID: "share1", Protocol: "smb", URL: "smb://server/games", Name: "Family Library"}
	setActiveSources([]networkSource{source})
	original := healthNetworkList
	defer func() { healthNetworkList = original }()
	healthNetworkList = func(ctx context.Context, value networkSource) ([]remoteItem, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("network probe has no deadline")
		}
		return nil, errors.New("secret-password at internal config path")
	}
	resetHealthCache()
	runHealthCheck()
	r := httptest.NewRecorder()
	handleHealth(r, httptest.NewRequest("GET", "/api/health", nil))
	if strings.Contains(r.Body.String(), "secret-password") || !strings.Contains(r.Body.String(), `"state":"critical"`) {
		t.Fatal(r.Body.String())
	}
	healthNetworkList = func(context.Context, networkSource) ([]remoteItem, error) {
		return []remoteItem{{IsDir: true}, {IsDir: false}}, nil
	}
	runHealthCheck()
	if healthSnapshot().Sources[0].State != "healthy" || healthSnapshot().Sources[0].Games != 1 {
		t.Fatal("network recovery failed")
	}
}
func TestHealthBackupRestoreAndFinalLogExportEntry(t *testing.T) {
	root, _ := setupFreshServer(t)
	rootDir, rootDirs = root, []string{root}
	resetHealthCache()
	runHealthCheck()
	var backup bytes.Buffer
	if err := writeLibraryBackupWithHealth(&backup, false, true, true, map[string]bool{}, nil, true); err != nil {
		t.Fatal(err)
	}
	archive, err := parseRestoreArchive(backup.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseRestoreArchive(restoreZIP(t, map[string][]byte{"library-health.json": archive.health})); err != nil {
		t.Fatal("health-only archive rejected", err)
	}
	if _, err := validateHealthArchive(archive.health); err != nil {
		t.Fatal("health missing from backup", err)
	}
	// Restore goes through the validated transactional path, including the preview hash.
	resetHealthCache()
	os.Remove(filepath.Join(dataDir, "library-health.json"))
	digest := sha256.Sum256(backup.Bytes())
	request := httptest.NewRequest("POST", "/api/library-restore?apply=1&health=1", bytes.NewReader(backup.Bytes()))
	request.Header.Set("X-Preview-SHA256", hex.EncodeToString(digest[:]))
	r := httptest.NewRecorder()
	handleLibraryRestore(r, request)
	if r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	if len(healthSnapshot().Events) != 1 {
		t.Fatal("health history not restored")
	}
	r = httptest.NewRecorder()
	handleLogs(r, httptest.NewRequest("GET", "/api/logs?export=1", nil))
	lines := strings.Split(strings.TrimSpace(r.Body.String()), "\n")
	if !strings.HasSuffix(lines[len(lines)-1], "[system] Application logs exported") {
		t.Fatal("export event is not final", lines[len(lines)-1])
	}
	// Untrusted archives cannot import arbitrary or oversized health states.
	invalid, _ := json.Marshal(healthArchive{Version: 1, Sources: []libraryHealth{{State: "pretend"}}})
	if _, err := parseRestoreArchive(restoreZIP(t, map[string][]byte{"library-health.json": invalid})); err == nil {
		t.Fatal("invalid health accepted")
	}
}
func TestHealthOptionsValidationAndPermissionSeparation(t *testing.T) {
	setupFreshServer(t)
	cookie := familyCreate(t, map[string]accessRule{"health": {"disable", false, ""}, "healthView": {"allow", false, ""}})
	settingsMu.RLock()
	value := configuredSettings
	settingsMu.RUnlock()
	value.Health = &healthOptions{true, 30}
	if r := familyGate(t, "/api/server-settings", "PUT", value, cookie); r.Code != http.StatusForbidden {
		t.Fatal("monitor configuration bypass", r.Code)
	}
	if r := familyGate(t, "/api/health", "GET", nil, cookie); r.Code != 204 {
		t.Fatal("view status incorrectly blocked", r.Code)
	}
	if validateHealthOptions(&healthOptions{true, 29}) == nil || validateHealthOptions(&healthOptions{false, 86401}) == nil || validateHealthOptions(nil) != nil {
		t.Fatal("invalid monitoring interval validation")
	}
}
