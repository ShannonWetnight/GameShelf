package main

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDownloadCartPackagesSelectedGames(t *testing.T) {
	setupLibrary(t)
	writeGame(t, "Alpha")
	writeGame(t, "Beta")
	if err := refreshGames(); err != nil { t.Fatal(err) }
	w := httptest.NewRecorder()
	handleDownloadCart(w, httptest.NewRequest(http.MethodGet, "/download-cart?game=alpha&game=beta", nil))
	if w.Code != http.StatusOK { t.Fatalf("status %d: %s", w.Code, w.Body.String()) }
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil { t.Fatal(err) }
	if len(archive.File) != 2 || archive.File[0].Name != "alpha/game.txt" || archive.File[1].Name != "beta/game.txt" {
		t.Fatalf("cart contents: %#v", archive.File)
	}
	for _, file := range archive.File {
		reader, err := file.Open(); if err != nil { t.Fatal(err) }
		contents, err := io.ReadAll(reader); reader.Close()
		if err != nil || string(contents) != "game data" { t.Fatalf("%s contents: %q (%v)", file.Name, contents, err) }
	}
	for _, selection := range []string{"", "?game=missing", "?game=alpha&game=alpha"} {
		w := httptest.NewRecorder()
		handleDownloadCart(w, httptest.NewRequest(http.MethodGet, "/download-cart"+selection, nil))
		if w.Code == http.StatusOK { t.Fatalf("accepted invalid cart %q", selection) }
	}
}

func TestLogRetentionAndAlwaysAvailableView(t *testing.T) {
	var retained boundedLog
	retained.Configure(&logOptions{OverrideSize:true, SizeMB:1, OverrideDays:true, Days:1})
	retained.Write([]byte(time.Now().Add(-48*time.Hour).Format("2006/01/02 15:04:05") + " expired\n"))
	retained.Write([]byte(time.Now().Format("2006/01/02 15:04:05") + " current\n"))
	if snapshot := string(retained.Snapshot()); strings.Contains(snapshot, "expired") || !strings.Contains(snapshot, "current") {
		t.Fatalf("log retention: %q", snapshot)
	}
	applicationLogs.Write([]byte("base application log marker\n"))
	w := httptest.NewRecorder()
	handleLogs(w, httptest.NewRequest(http.MethodGet, "/api/logs", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "base application log marker") {
		t.Fatalf("log snapshot %d: %q", w.Code, w.Body.String())
	}
}
