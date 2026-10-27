package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/rclone/rclone/backend/local"
)

func TestSingleFileReadAndReplacement(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "game.bin")
	if err := os.WriteFile(file, []byte("payload"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		offset, count int64
		want          string
	}{
		{0, -1, "payload"}, {2, 3, "ylo"}, {0, 0, ""}, {7, 4, ""}, {0, 20, "payload"},
	} {
		var got bytes.Buffer
		if err := readSingleFile(context.Background(), &got, file, test.offset, test.count); err != nil || got.String() != test.want {
			t.Fatalf("range %d/%d: %q, %v", test.offset, test.count, got.String(), err)
		}
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(file, "unindexed-secret.bin"), []byte("outside-index"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, count := range []int64{-1, 0, 7} {
		var got bytes.Buffer
		if err := readSingleFile(context.Background(), &got, file, 0, count); err == nil || got.Len() != 0 {
			t.Fatalf("directory replacement must fail before output: %q, %v", got.String(), err)
		}
	}
}

func TestSingleFileDoesNotListDirectory(t *testing.T) {
	// A directory is rejected even when empty, and invalid ranges fail early.
	var got bytes.Buffer
	for _, remote := range []string{t.TempDir(), t.TempDir() + "/"} {
		if err := readSingleFile(context.Background(), &got, remote, 0, -1); err == nil {
			t.Fatal("accepted directory")
		}
	}
	if err := readSingleFile(context.Background(), &got, "invalid:", -1, 1); err == nil {
		t.Fatal("accepted negative offset")
	}
	if err := readSingleFile(context.Background(), &got, "invalid:", 0, -2); err == nil {
		t.Fatal("accepted invalid count")
	}
}
