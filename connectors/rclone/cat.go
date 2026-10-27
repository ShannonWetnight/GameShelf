package main

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/rclone/rclone/cmd"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/fspath"
	"github.com/spf13/cobra"
)

// Unlike rclone cat, a GameShelf read must never expand a directory into a
// recursive download when an indexed file has been replaced by a directory.
// This does not prevent server-side symlink resolution or atomic path races.
func readSingleFile(ctx context.Context, dst io.Writer, remote string, offset, count int64) (err error) {
	if offset < 0 || count < -1 {
		return errors.New("invalid file range")
	}
	parent, name, err := fspath.Split(remote)
	if err != nil || name == "" {
		return errors.New("a single file is required")
	}
	if parent == "" {
		parent = "."
	}
	f, err := fs.NewFs(ctx, parent)
	if err != nil {
		return err
	}
	object, err := f.NewObject(ctx, name)
	if err != nil {
		return err
	}
	if count == 0 {
		return nil
	}
	// Limit locally too: a server may ignore a requested range.
	options := []fs.OpenOption{&fs.SeekOption{Offset: offset}}
	in, err := object.Open(ctx, options...)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := in.Close(); err == nil {
			err = closeErr
		}
	}()
	var reader io.Reader = in
	if count >= 0 {
		reader = io.LimitReader(in, count)
	}
	_, err = io.Copy(dst, reader)
	return err
}

func init() {
	var offset int64
	count := int64(-1)
	command := &cobra.Command{
		Use:   "cat remote:file",
		Short: "Read exactly one file without directory expansion",
		Run: func(command *cobra.Command, args []string) {
			cmd.CheckArgs(1, 1, command, args)
			cmd.Run(false, false, command, func() error {
				return readSingleFile(context.Background(), os.Stdout, args[0], offset, count)
			})
		},
	}
	command.Flags().Int64Var(&offset, "offset", 0, "Starting byte")
	command.Flags().Int64Var(&count, "count", -1, "Maximum bytes")
	cmd.Root.AddCommand(command)
}
