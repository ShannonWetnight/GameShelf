package main

// Missing pinRequired means true, preserving protection for existing profiles
// and older backups. Administrative permission changes must never turn an
// unprotected shelf into a privileged identity.
var profileAdministrativeActions = []string{
	"settings", "advanced", "admin", "libraryManager", "sources", "storage",
	"refresh", "logging", "health", "export", "restore", "wipe", "setup",
	"covers", "titles", "metadata",
}

func profileRequiresPIN(p familyProfile) bool { return p.PINRequired == nil || *p.PINRequired }
func profileHasAdministrativeActions(db *profileDatabase, p familyProfile) bool {
	rules := mergedProfileRules(db, p)
	for _, action := range profileAdministrativeActions {
		if rules[action].Mode != "disable" {
			return true
		}
	}
	return false
}
