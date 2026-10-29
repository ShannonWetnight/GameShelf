package main

import (
	"encoding/json"
	"net/http"
	"sort"
)

type libraryView struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	State string `json:"state"`
	Games int    `json:"games"`
}

func libraryViewHealthAllowed(r *http.Request) bool {
	policy, _, err := currentAccessPolicy()
	if err != nil {
		return false
	}
	policy = combinedAccessPolicy(r, policy)
	for _, action := range accessDependencies(policy, []string{"healthView"}, true) {
		mode := policyMode(policy, action)
		if mode == "disable" || mode != "allow" && !hasPINGrant(r, action) {
			return false
		}
	}
	return true
}

// Browsing needs a source label and cached status, never connection details.
// Apply the effective profile limits before exposing even an empty source.
func handleLibraryView(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Vary", "Cookie")
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	libraryRuntimeMu.RLock()
	defer libraryRuntimeMu.RUnlock()
	active, cached := activeHealthSources(), healthSnapshot()
	healthAllowed := libraryViewHealthAllowed(r)
	counts := map[string]int{}
	gamesMu.RLock()
	for _, entry := range gamesMap {
		if profileAllows(r, entry) {
			counts[profileLibraryID(entry)]++
		}
	}
	gamesMu.RUnlock()
	settingsMu.RLock()
	monitored := normalizeHealthOptions(configuredSettings.Health).Enabled
	settingsMu.RUnlock()
	list := []libraryView{}
	seen := map[string]bool{}
	for _, source := range active {
		id := source.ID
		if source.Protocol == "folder" {
			id = localLibraryID(source.Location)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		if view := profileView(r); view != nil {
			p := view.Profile
			if (!p.AllLibraries && !containsProfileID(p.Libraries, id)) || (!p.AllGames && counts[id] == 0) {
				continue
			}
		}
		state := "unknown"
		for _, saved := range cached.Sources {
			if saved.ID == source.ID && saved.Identity == source.Identity {
				switch saved.State {
				case "healthy", "degraded", "critical":
					state = saved.State
				}
				break
			}
		}
		if !monitored {
			state = "disabled"
		}
		if !healthAllowed {
			state = "restricted"
		}
		name := source.Name
		if name == "" || name == source.Location {
			name = "Network library"
			if source.Protocol == "folder" {
				name = "Local library"
			}
		}
		list = append(list, libraryView{ID: id, Name: name, State: state, Games: counts[id]})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Name == list[j].Name {
			return list[i].ID < list[j].ID
		}
		return list[i].Name < list[j].Name
	})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// Inheritance is opt-in. Group grants are combined, then intersected with the
// profile's saved library selection. Game restrictions remain an additional cap.
// Work on a copy so management and backups retain the original individual limits.
func effectiveProfileLibraries(db *profileDatabase, p familyProfile) familyProfile {
	if !p.InheritLibraries || p.UsesGuardianPIN {
		return p
	}
	all := false
	granted := map[string]bool{}
	for _, id := range p.Groups {
		group, exists := db.Groups[id]
		if !exists {
			continue
		}
		switch group.LibraryPolicy {
		case "all":
			all = true
		case "selected":
			for _, library := range group.Libraries {
				granted[library] = true
			}
		}
	}
	if all {
		return p
	}
	allowed := []string{}
	for library := range granted {
		if p.AllLibraries || containsProfileID(p.Libraries, library) {
			allowed = append(allowed, library)
		}
	}
	sort.Strings(allowed)
	p.AllLibraries = false
	p.Libraries = allowed
	return p
}
