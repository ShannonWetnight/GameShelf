package main

import (
	"encoding/base64"
	"os"
)

// A Guardian can use the shared PIN without creating a persistent profile.
// Associated profiles reference that private verifier; backups never copy it.
func standaloneGuardian() familyProfile {
	required := true
	return familyProfile{ID: "guardian", Nickname: "GameShelf Guardian", Avatar: "builtin:ember-knight", Roles: []string{"administrator"}, PINRequired: &required, UsesGuardianPIN: true, AllLibraries: true, AllGames: true}
}
func sessionProfile(db *profileDatabase, session profileSession) (familyProfile, bool) {
	if session.Guardian {
		return standaloneGuardian(), true
	}
	p, ok := db.Profiles[session.Profile]
	return p, ok
}
func guardianAvailable() bool { record, err := readPINRecord(); return err == nil && record != nil }
func guardianProfilePicker(db *profileDatabase) bool {
	if !db.Enabled || !guardianAvailable() {
		return false
	}
	for _, p := range db.Profiles {
		if p.UsesGuardianPIN {
			return false
		}
	}
	return true
}
func profilePINVerifier(p familyProfile) ([]byte, []byte, int, error) {
	if p.UsesGuardianPIN {
		record, err := readPINRecord()
		if err != nil {
			return nil, nil, 0, err
		}
		if record == nil {
			return nil, nil, 0, os.ErrNotExist
		}
		salt, _ := base64.StdEncoding.DecodeString(record.Salt)
		hash, _ := base64.StdEncoding.DecodeString(record.Hash)
		return salt, hash, record.Iterations, nil
	}
	salt, _ := base64.StdEncoding.DecodeString(p.Salt)
	hash, _ := base64.StdEncoding.DecodeString(p.Hash)
	return salt, hash, pinIterations, nil
}

// Called while accessConfigMu serializes Guardian PIN changes.
func revokeGuardianProfiles() {
	profileMu.Lock()
	defer profileMu.Unlock()
	db, err := readProfileDBLocked()
	for token, s := range profileSessions {
		if s.Guardian || err != nil || db.Profiles[s.Profile].UsesGuardianPIN {
			delete(profileSessions, token)
		}
	}
}
