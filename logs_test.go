package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLogsRemainAvailableWithoutVerboseLogging(t *testing.T) {
	previous := verboseLogging.Load()
	t.Cleanup(func() { verboseLogging.Store(previous) })
	verboseLogging.Store(false)
	applicationLogs.Write([]byte("unique-log-viewer-entry\n"))
	w := httptest.NewRecorder()
	handleLogs(w, httptest.NewRequest(http.MethodGet, "/api/logs", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "unique-log-viewer-entry") {
		t.Fatalf("base logs: %d %q", w.Code, w.Body.String())
	}

	verboseLogging.Store(true)
	w = httptest.NewRecorder()
	handleLogs(w, httptest.NewRequest(http.MethodGet, "/api/logs", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "unique-log-viewer-entry") {
		t.Fatalf("enabled logs: %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" { t.Fatal("logs must not be cached") }
}
