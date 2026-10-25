//go:build connector_testservers

// Test fixture commands are excluded from the shipped connector.
package main

import (
	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/cmd/serve/ftp"
	_ "github.com/rclone/rclone/cmd/serve/sftp"
	_ "github.com/rclone/rclone/cmd/serve/webdav"
)
