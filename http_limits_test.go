package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func limitedHTTPServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	s := httptest.NewUnstartedServer(handler)
	s.Config = newGameShelfHTTPServer("", handler)
	if s.Config.ReadHeaderTimeout <= 0 || s.Config.IdleTimeout <= 0 || s.Config.MaxHeaderBytes <= 0 {
		t.Fatal("connection limits are disabled")
	}
	// Scale the production limits for loopback tests without replacing them.
	s.Config.ReadHeaderTimeout /= 100
	s.Config.IdleTimeout /= 1200
	s.Start()
	t.Cleanup(s.Close)
	return s
}

func rawHTTPConnection(t *testing.T, s *httptest.Server) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", s.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	return conn
}

func TestHTTPConnectionLimitsRejectIncompleteAndOversizedHeaders(t *testing.T) {
	var handled atomic.Bool
	s := limitedHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handled.Store(true); w.WriteHeader(204) }))
	conn := rawHTTPConnection(t, s)
	if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: "); err != nil {
		t.Fatal(err)
	}
	_, err := io.ReadAll(conn)
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("incomplete headers outlived the server deadline")
	}
	if handled.Load() {
		t.Fatal("partial headers reached the handler")
	}
	conn.Close()
	conn = rawHTTPConnection(t, s)
	request := "GET / HTTP/1.1\r\nHost: localhost\r\nX-Large: " + strings.Repeat("x", s.Config.MaxHeaderBytes+8192) + "\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusRequestHeaderFieldsTooLarge || handled.Load() {
		t.Fatal("oversized headers accepted", response.StatusCode)
	}
}

func TestHTTPConnectionLimitsPreserveLargeExportSelectionQuery(t *testing.T) {
	query := "select=1&" + strings.Repeat("cover=long-game-identifier&", 5000)
	s := limitedHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != query {
			http.Error(w, "selection was truncated", 400)
			return
		}
		w.WriteHeader(204)
	}))
	client := s.Client()
	client.Timeout = 3 * time.Second
	response, err := client.Get(s.URL + "/api/library-backup?" + query)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("existing export selection rejected", response.StatusCode)
	}
}

func TestHTTPIdleLimitClosesUnusedKeepAliveConnection(t *testing.T) {
	s := limitedHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	conn := rawHTTPConnection(t, s)
	if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(data) != "ok" {
		t.Fatal(string(data), err)
	}
	_, err = reader.ReadByte()
	if err == nil {
		t.Fatal("idle connection produced unexpected data")
	}
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("idle connection was retained beyond its deadline")
	}
}

func TestHTTPHeaderDeadlinePreservesSlowBodiesAndStreamingResponses(t *testing.T) {
	var delay atomic.Int64
	s := limitedHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			data, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			fmt.Fprintf(w, "read %d", len(data))
			return
		}
		io.WriteString(w, "first")
		w.(http.Flusher).Flush()
		time.Sleep(time.Duration(delay.Load()))
		io.WriteString(w, "last")
	}))
	delay.Store(int64(3 * s.Config.ReadHeaderTimeout))
	client := s.Client()
	client.Timeout = 3 * time.Second
	response, err := client.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(data) != "firstlast" {
		t.Fatal("stream interrupted by header deadline", string(data), err)
	}
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		_, err := writer.Write([]byte("first"))
		if err == nil {
			time.Sleep(time.Duration(delay.Load()))
			_, err = writer.Write([]byte("last"))
		}
		writer.CloseWithError(err)
		done <- err
	}()
	response, err = client.Post(s.URL, "application/octet-stream", reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	data, err = io.ReadAll(response.Body)
	response.Body.Close()
	if writeErr := <-done; writeErr != nil {
		t.Fatal(writeErr)
	}
	if err != nil || response.StatusCode != 200 || string(data) != "read 9" {
		t.Fatal("slow body interrupted", response.StatusCode, string(data), err)
	}
}
