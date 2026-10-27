package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type healthOptions struct {
	Enabled         bool `json:"enabled"`
	IntervalSeconds int  `json:"intervalSeconds"`
}

func normalizeHealthOptions(value *healthOptions) *healthOptions {
	if value == nil {
		return &healthOptions{true, 300}
	}
	copy := *value
	return &copy
}
func validateHealthOptions(value *healthOptions) error {
	copy := normalizeHealthOptions(value)
	if copy.IntervalSeconds < 30 || copy.IntervalSeconds > 86400 {
		return errors.New("health checks must be 30–86400 seconds apart")
	}
	return nil
}

type healthEvent struct {
	At      time.Time `json:"at"`
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	State   string    `json:"state"`
	Message string    `json:"message"`
}
type libraryHealth struct {
	ID                  string    `json:"id"`
	Identity            string    `json:"identity"`
	Name                string    `json:"name"`
	Protocol            string    `json:"protocol"`
	Location            string    `json:"location"`
	State               string    `json:"state"`
	Message             string    `json:"message"`
	LastChecked         time.Time `json:"lastChecked"`
	LastSuccess         time.Time `json:"lastSuccess"`
	ConsecutiveFailures int       `json:"consecutiveFailures"`
	Games               int       `json:"games"`
}
type healthArchive struct {
	Version int             `json:"version"`
	Sources []libraryHealth `json:"sources"`
	Events  []healthEvent   `json:"events"`
}

var healthMu sync.Mutex
var healthData = healthArchive{Version: 1}
var healthHome string
var healthChecking bool
var healthGeneration uint64
var healthSchedule = make(chan struct{}, 1)
var healthNetworkList = func(ctx context.Context, source networkSource) ([]remoteItem, error) {
	return networkList(ctx, source, false)
}

func notifyHealthSchedule() {
	select {
	case healthSchedule <- struct{}{}:
	default:
	}
}
func validateHealthArchive(contents []byte) (healthArchive, error) {
	var data healthArchive
	if len(contents) > 2<<20 || json.Unmarshal(contents, &data) != nil || data.Version != 1 || len(data.Sources) > 16 || len(data.Events) > 500 {
		return data, errors.New("invalid health history")
	}
	valid := func(state string) bool {
		return state == "healthy" || state == "degraded" || state == "critical" || state == "unknown"
	}
	for _, source := range data.Sources {
		if len(source.ID) > 80 || len(source.Identity) > 100 || len(source.Name) > 256 || len(source.Location) > 2048 || len(source.Message) > 300 || !valid(source.State) || source.ConsecutiveFailures < 0 || source.ConsecutiveFailures > 100000 || source.Games < 0 {
			return data, errors.New("invalid health source")
		}
	}
	for _, event := range data.Events {
		if len(event.ID) > 80 || len(event.Name) > 256 || len(event.Message) > 300 || !valid(event.State) {
			return data, errors.New("invalid health event")
		}
	}
	return data, nil
}
func loadHealthLocked() {
	if healthHome == dataDir {
		return
	}
	healthHome = dataDir
	healthData = healthArchive{Version: 1}
	if file, err := os.Open(filepath.Join(dataDir, "library-health.json")); err == nil {
		contents, readErr := io.ReadAll(io.LimitReader(file, (2<<20)+1))
		file.Close()
		if readErr == nil {
			if saved, err := validateHealthArchive(contents); err == nil {
				healthData = saved
			}
		}
	}
}
func healthSnapshot() healthArchive {
	healthMu.Lock()
	defer healthMu.Unlock()
	loadHealthLocked()
	copy := healthData
	copy.Sources = append([]libraryHealth(nil), healthData.Sources...)
	copy.Events = append([]healthEvent(nil), healthData.Events...)
	return copy
}
func healthArchiveBytes() ([]byte, error) { return json.MarshalIndent(healthSnapshot(), "", "  ") }
func resetHealthCache()                   { healthMu.Lock(); healthHome = ""; healthMu.Unlock(); notifyHealthSchedule() }
func activeHealthSources() []libraryHealth {
	roots := append([]string(nil), rootDirs...)
	if len(roots) == 0 && rootDir != "" {
		roots = []string{rootDir}
	}
	sources := []libraryHealth{}
	for _, root := range roots {
		hash := sha256.Sum256([]byte(root))
		id := "local-" + hex.EncodeToString(hash[:12])
		sources = append(sources, libraryHealth{ID: id, Identity: id, Name: filepath.Base(root), Protocol: "folder", Location: root, State: "unknown"})
	}
	for _, source := range snapshotSources() {
		name := source.Name
		if name == "" {
			name = source.URL
		}
		identity := sha256.Sum256([]byte(networkIdentity(source)))
		sources = append(sources, libraryHealth{ID: source.ID, Identity: hex.EncodeToString(identity[:]), Name: name, Protocol: source.Protocol, Location: source.URL, State: "unknown"})
	}
	return sources
}

// Mounted filesystems can hang inside ReadDir. Share one bounded in-flight probe
// per path so repeated checks never accumulate blocked filesystem goroutines.
type localHealthProbe struct {
	done    chan struct{}
	entries []os.DirEntry
	err     error
}

var localHealthMu sync.Mutex
var localHealthProbes = map[string]*localHealthProbe{}
var healthReadDir = os.ReadDir
var healthProbeTimeout = 6 * time.Second

func localHealthList(path string) ([]os.DirEntry, error) {
	localHealthMu.Lock()
	probe := localHealthProbes[path]
	if probe == nil {
		if len(localHealthProbes) >= 16 {
			localHealthMu.Unlock()
			return nil, errors.New("folder check capacity reached")
		}
		probe = &localHealthProbe{done: make(chan struct{})}
		localHealthProbes[path] = probe
		go func() {
			probe.entries, probe.err = healthReadDir(path)
			close(probe.done)
			localHealthMu.Lock()
			if localHealthProbes[path] == probe {
				delete(localHealthProbes, path)
			}
			localHealthMu.Unlock()
		}()
	}
	localHealthMu.Unlock()
	timer := time.NewTimer(healthProbeTimeout)
	defer timer.Stop()
	select {
	case <-probe.done:
		return probe.entries, probe.err
	case <-timer.C:
		return nil, errors.New("folder check timed out")
	}
}
func runHealthCheck() {
	libraryRuntimeMu.RLock()
	healthMu.Lock()
	if healthChecking {
		healthMu.Unlock()
		libraryRuntimeMu.RUnlock()
		return
	}
	healthChecking = true
	loadHealthLocked()
	generation := healthGeneration
	old := append([]libraryHealth(nil), healthData.Sources...)
	healthMu.Unlock()
	defer func() { healthMu.Lock(); healthChecking = false; healthMu.Unlock() }()
	sources := activeHealthSources()
	network := snapshotSources()
	home := dataDir
	libraryRuntimeMu.RUnlock()
	now := time.Now().UTC()
	for index := range sources {
		value := &sources[index]
		for _, previous := range old {
			if value.ID == previous.ID && value.Identity == previous.Identity {
				value.LastSuccess = previous.LastSuccess
				value.ConsecutiveFailures = previous.ConsecutiveFailures
			}
		}
		var err error
		count := 0
		if value.Protocol == "folder" {
			var entries []os.DirEntry
			entries, err = localHealthList(value.Location)
			if err == nil {
				for _, entry := range entries {
					if entry.IsDir() {
						count++
					}
				}
			}
		} else {
			for _, source := range network {
				if source.ID == value.ID {
					ctx, cancel := context.WithTimeout(context.Background(), healthProbeTimeout)
					var entries []remoteItem
					entries, err = healthNetworkList(ctx, source)
					cancel()
					if err == nil {
						for _, entry := range entries {
							if entry.IsDir {
								count++
							}
						}
					}
					break
				}
			}
		}
		value.LastChecked = now
		value.Games = count
		if err == nil {
			value.State = "healthy"
			value.Message = "Location is readable"
			value.LastSuccess = now
			value.ConsecutiveFailures = 0
		} else {
			value.ConsecutiveFailures++
			if value.ConsecutiveFailures > 100000 {
				value.ConsecutiveFailures = 100000
			}
			value.State = "degraded"
			value.Message = "Connection check failed; verify the server and saved sign-in"
			if value.Protocol == "folder" {
				value.Message = "Folder is unavailable or cannot be read"
			}
			if value.LastSuccess.IsZero() || value.ConsecutiveFailures >= 3 {
				value.State = "critical"
			}
			gamesMu.RLock()
			for _, entry := range gamesMap {
				if (value.Protocol == "folder" && entryRootDir(entry) == value.Location) || (value.Protocol != "folder" && entry.NetworkID == value.ID) {
					value.Games++
				}
			}
			gamesMu.RUnlock()
		}
	}
	libraryRuntimeMu.RLock()
	defer libraryRuntimeMu.RUnlock()
	if home != dataDir {
		return
	}
	healthMu.Lock()
	if generation != healthGeneration {
		healthMu.Unlock()
		return
	}
	loadHealthLocked()
	healthData.Sources = sources
	for _, source := range sources {
		healthData.Events = append(healthData.Events, healthEvent{now, source.ID, source.Name, source.State, source.Message})
		logEvent("health", "Library location %s: %s (%s)", source.ID, source.State, source.Message)
	}
	if len(healthData.Events) > 500 {
		healthData.Events = healthData.Events[len(healthData.Events)-500:]
	}
	saved := healthData
	healthMu.Unlock()
	if err := savePrivateJSON(filepath.Join(dataDir, "library-health.json"), saved); err != nil {
		logEvent("errors", "Library health history could not be saved")
	}
	degraded, critical := 0, 0
	for _, source := range sources {
		if source.State == "degraded" {
			degraded++
		}
		if source.State == "critical" {
			critical++
		}
	}
	logEvent("health", "Library health check: %d locations, %d degraded, %d critical", len(sources), degraded, critical)
}
func runHealthMonitor() {
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			settingsMu.RLock()
			options := normalizeHealthOptions(configuredSettings.Health)
			settingsMu.RUnlock()
			if options.Enabled && !setupRequired.Load() {
				runHealthCheck()
			}
			timer.Reset(time.Duration(options.IntervalSeconds) * time.Second)
		case <-healthSchedule:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			settingsMu.RLock()
			options := normalizeHealthOptions(configuredSettings.Health)
			settingsMu.RUnlock()
			timer.Reset(time.Duration(options.IntervalSeconds) * time.Second)
		}
	}
}
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == "POST" && r.URL.Path == "/api/health/check" {
		go runHealthCheck()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(202)
		w.Write([]byte("{\"checking\":true}"))
		return
	}
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	libraryRuntimeMu.RLock()
	data := healthSnapshot()
	active := activeHealthSources()
	libraryRuntimeMu.RUnlock()
	sources := []libraryHealth{}
	for _, current := range active {
		matched := false
		for _, saved := range data.Sources {
			if saved.ID == current.ID && saved.Identity == current.Identity {
				sources = append(sources, saved)
				matched = true
				break
			}
		}
		if !matched {
			sources = append(sources, current)
		}
	}
	state := "unknown"
	if len(sources) > 0 {
		state = "healthy"
	}
	for _, source := range sources {
		if source.State == "critical" {
			state = "critical"
			break
		}
		if source.State == "degraded" || source.State == "unknown" {
			state = "degraded"
		}
	}
	healthMu.Lock()
	checking := healthChecking
	healthMu.Unlock()
	settingsMu.RLock()
	options := normalizeHealthOptions(configuredSettings.Health)
	settingsMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"state": state, "sources": sources, "events": data.Events, "checking": checking, "options": options})
}
func logSnapshotForExport(message string) []byte {
	entry := []byte(time.Now().Format("2006/01/02 15:04:05") + " [system] " + strings.ReplaceAll(message, "\n", " ") + "\n")
	applicationLogs.mu.Lock()
	applicationLogs.data = append(applicationLogs.data, entry...)
	applicationLogs.prune()
	snapshot := append([]byte(nil), applicationLogs.data...)
	applicationLogs.mu.Unlock()
	fmt.Fprint(os.Stdout, string(entry))
	return snapshot
}
