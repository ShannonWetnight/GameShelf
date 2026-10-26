package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"strings"
)

// Photos live in the protected profile document, so backup/restore is atomic
// and cannot lose an external image file. Browser uploads are square JPEGs.
const maxProfileAvatarBytes = 96 << 10

var profileAvatarNames = map[string]bool{
	"star-pilot":       true,
	"ember-knight":     true,
	"meadow-ranger":    true,
	"pixel-robot":      true,
	"neon-racer":       true,
	"moon-mage":        true,
	"deep-diver":       true,
	"sky-courier":      true,
	"garden-sprout":    true,
	"pirate-captain":   true,
	"arcane-scholar":   true,
	"desert-nomad":     true,
	"frost-guardian":   true,
	"puzzle-owl":       true,
	"circuit-cat":      true,
	"crystal-dragon":   true,
	"iron-engineer":    true,
	"court-champion":   true,
	"rhythm-dj":        true,
	"wandering-chef":   true,
	"shadow-detective": true,
	"ocean-navigator":  true,
	"retro-astronaut":  true,
	"forest-sprite":    true,
	"cosmic-fox":       true,
}

func profileAvatarBytes(value string) ([]byte, error) {
	const prefix = "data:image/jpeg;base64,"
	if !strings.HasPrefix(value, prefix) || len(value) > len(prefix)+base64.StdEncoding.EncodedLen(maxProfileAvatarBytes) {
		return nil, errors.New("Choose a built-in photo or upload a square profile photo")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(value, prefix))
	if err != nil || len(data) > maxProfileAvatarBytes {
		return nil, errors.New("Profile photo is too large or invalid")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "jpeg" || config.Width != 256 || config.Height != 256 {
		return nil, errors.New("Profile photos must be square 256 × 256 JPEG images")
	}
	return data, nil
}
func validateProfileAvatar(value string) error {
	if value == "" {
		return nil
	}
	if strings.HasPrefix(value, "builtin:") {
		if profileAvatarNames[strings.TrimPrefix(value, "builtin:")] {
			return nil
		}
		return errors.New("Choose an available profile photo")
	}
	_, err := profileAvatarBytes(value)
	return err
}
func normalizeProfileAvatar(value string) (string, error) {
	if value == "" || strings.HasPrefix(value, "builtin:") {
		return value, validateProfileAvatar(value)
	}
	data, err := profileAvatarBytes(value)
	if err != nil {
		return "", err
	}
	photo, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("Could not read this profile photo")
	}
	var output bytes.Buffer
	if err := jpeg.Encode(&output, photo, &jpeg.Options{Quality: 88}); err != nil {
		return "", err
	}
	if output.Len() > maxProfileAvatarBytes {
		return "", errors.New("Profile photo is too large")
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(output.Bytes()), nil
}
