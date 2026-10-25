package main

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// A server-wide quiet period prevents concurrent clients/autoclickers from
// queueing repeated discovery passes. Automatic scans keep their own schedule.
const manualRefreshCooldown = 10 * time.Second

var manualRefreshMu sync.Mutex
var manualRefreshLast time.Time
var manualRefreshActive bool
var manualRefreshHome string

func admitManualRefresh(w http.ResponseWriter, r *http.Request) bool {
	manualRefreshMu.Lock()
	defer manualRefreshMu.Unlock()
	now := time.Now()
	if manualRefreshHome != settingsHome {
		manualRefreshHome = settingsHome
		manualRefreshLast = time.Time{}
		manualRefreshActive = false
	}
	remaining := manualRefreshCooldown - now.Sub(manualRefreshLast)
	if remaining > 0 || manualRefreshActive {
		if remaining <= 0 {
			remaining = manualRefreshCooldown
		}
		seconds := int((remaining + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Please wait a moment before refreshing again.", http.StatusTooManyRequests)
		return false
	}
	manualRefreshLast = now
	manualRefreshActive = true
	return true
}

func finishManualRefresh() {
	manualRefreshMu.Lock()
	manualRefreshActive = false
	manualRefreshMu.Unlock()
}
