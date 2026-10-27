package main

import (
	"context"
	"errors"
	"io"
	iofs "io/fs"
	"os"
	"strings"

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
	return streamObject(ctx, dst, object, offset, count)
}

// SFTP skip_links is implemented by List, not NewObject/Open. Walk from the
// configured source using those listings so stable post-index link replacements
// receive the same policy as discovery. Separate List/Open calls still race.
func readListedFile(ctx context.Context, dst io.Writer, root, relative string, offset, count int64) error {
	if !iofs.ValidPath(relative) || relative == "." || strings.ContainsAny(relative, "\\\x00\r\n") || offset < 0 || count < -1 {
		return errors.New("invalid library file or range")
	}
	f, err := fs.NewFs(ctx, root)
	if err != nil {
		return err
	}
	directory := ""
	parts := strings.Split(relative, "/")
	for index, part := range parts {
		entries, err := f.List(ctx, directory)
		if err != nil {
			return err
		}
		remote := part
		if directory != "" {
			remote = directory + "/" + part
		}
		var found fs.DirEntry
		for _, entry := range entries {
			if entry.Remote() == remote {
				found = entry
				break
			}
		}
		if index == len(parts)-1 {
			object, ok := found.(fs.Object)
			if !ok {
				return errors.New("library file is missing or is not a regular object")
			}
			return streamObject(ctx, dst, object, offset, count)
		}
		if _, ok := found.(fs.Directory); !ok {
			return errors.New("library directory is missing or excluded")
		}
		directory = remote
	}
	return errors.New("a library file is required")
}

func streamObject(ctx context.Context, dst io.Writer, object fs.Object, offset, count int64) (err error) {
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
	var file string
	count := int64(-1)
	command := &cobra.Command{
		Use:   "cat remote:file",
		Short: "Read exactly one file without directory expansion",
		Run: func(command *cobra.Command, args []string) {
			cmd.CheckArgs(1, 1, command, args)
			cmd.Run(false, false, command, func() error {
				if command.Flags().Changed("file") {
					return readListedFile(context.Background(), os.Stdout, args[0], file, offset, count)
				}
				return readSingleFile(context.Background(), os.Stdout, args[0], offset, count)
			})
		},
	}
	command.Flags().Int64Var(&offset, "offset", 0, "Starting byte")
	command.Flags().Int64Var(&count, "count", -1, "Maximum bytes")
	command.Flags().StringVar(&file, "file", "", "Source-relative file checked through directory listings")
	cmd.Root.AddCommand(command)
}
