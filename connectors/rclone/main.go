// GameShelf's read-only connector command set. No cloud storage backends,
// plugins, mount commands, sync, copy, or deletion commands are registered.
package main

import (
	_ "github.com/rclone/rclone/backend/ftp"
	_ "github.com/rclone/rclone/backend/sftp"
	_ "github.com/rclone/rclone/backend/smb"
	_ "github.com/rclone/rclone/backend/webdav"
	"github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/cat"
	_ "github.com/rclone/rclone/cmd/lsjson"
	_ "github.com/rclone/rclone/cmd/obscure"
	_ "github.com/rclone/rclone/cmd/version"
)

func main() { cmd.Main() }
