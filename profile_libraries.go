package main

import "sort"

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
