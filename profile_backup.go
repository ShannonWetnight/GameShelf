package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

type protectedProfiles struct {
	Version int    `json:"version"`
	Salt    string `json:"salt"`
	Nonce   string `json:"nonce"`
	Data    string `json:"data"`
}

func profileBackupKey(header string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(header)
	value := string(data)
	if err != nil || len(data) > 1024 || !utf8.Valid(data) || utf8.RuneCount(data) < 12 || strings.TrimSpace(value) == "" {
		return "", errors.New("Use a backup passphrase of at least 12 characters")
	}
	return value, nil
}
func profileBackupAEAD(pass string, salt []byte) (cipher.AEAD, error) {
	key, err := pbkdf2.Key(sha256.New, pass, salt, pinIterations, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func encodeProfilesBackup(header string) ([]byte, error) {
	pass, err := profileBackupKey(header)
	if err != nil {
		return nil, err
	}
	profileMu.Lock()
	db, err := readProfileDBLocked()
	if err != nil {
		profileMu.Unlock()
		return nil, err
	}
	data, err := json.Marshal(db)
	profileMu.Unlock()
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	if _, err = rand.Read(salt); err != nil {
		return nil, err
	}
	aead, err := profileBackupAEAD(pass, salt)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	sealed := aead.Seal(nil, nonce, data, []byte("GameShelf Family Profiles v1"))
	return json.Marshal(protectedProfiles{1, base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(nonce), base64.StdEncoding.EncodeToString(sealed)})
}
func decodeProfilesBackup(data []byte, header string) (*profileDatabase, error) {
	pass, err := profileBackupKey(header)
	if err != nil {
		return nil, err
	}
	var envelope protectedProfiles
	if len(data) > 48<<20 || json.Unmarshal(data, &envelope) != nil || envelope.Version != 1 {
		return nil, errors.New("Invalid protected family profile backup")
	}
	salt, e1 := base64.StdEncoding.DecodeString(envelope.Salt)
	nonce, e2 := base64.StdEncoding.DecodeString(envelope.Nonce)
	sealed, e3 := base64.StdEncoding.DecodeString(envelope.Data)
	if e1 != nil || e2 != nil || e3 != nil || len(salt) != 16 || len(nonce) != 12 || len(sealed) < 16 || len(sealed) > maxProfileData+16 {
		return nil, errors.New("Invalid protected family profile backup")
	}
	aead, err := profileBackupAEAD(pass, salt)
	if err != nil {
		return nil, err
	}
	plain, err := aead.Open(nil, nonce, sealed, []byte("GameShelf Family Profiles v1"))
	if err != nil {
		return nil, errors.New("Backup passphrase did not match or profile data was changed")
	}
	var db profileDatabase
	if json.Unmarshal(plain, &db) != nil || validateProfileDB(&db) != nil {
		return nil, errors.New("Invalid family profile data")
	}
	return &db, nil
}
