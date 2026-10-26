# Writable SMB security fixture

Run `python3 scripts/smb-write-smoke.py gameshelf:candidate` after building the
application image. Docker, Python 3, Node.js and Google Chrome are required;
`CHROME_BIN` can select another Chromium executable. Edge verification runs this
test alongside the existing six-protocol network smoke test.

The script creates a fresh internal Docker network and a Samba container whose
library exists only in a disposable tmpfs. A second temporary network publishes
only the application HTTP port to loopback; Samba stays on the internal network. It accepts an application image name,
with no option to target an existing server, credentials or library. Cleanup
removes both containers, application volumes and the network, including on test
failure. The application runs without root, capabilities or a mounted library.

Before starting GameShelf, `smbclient` independently proves that the same `writer`
credentials can create, overwrite, read, rename and delete a file, and create and
remove a directory. Each result is checked directly on the server. A failed
permission probe fails the test rather than silently testing a read-only share.

After probe cleanup, the server inventories all directories and files, including
empty directories and a hidden sentinel. It records names, file types, SHA-256
content hashes, sizes, ownership, permissions, link counts, modification/change
timestamps and extended attributes. Access time is excluded because reading may
update it. The inventory is compared after connection testing, setup/indexing,
refresh, file listing, artwork, full/range file downloads, ZIP and Playlist
downloads, browser Playlist add/remove/clear/download, rejected mutation requests
and application shutdown. Browser download completion is checked; API ZIP tests
also compare every member and its bytes.

`network_operations_test.go` separately checks that unsupported operations cannot
start either connector backend, and that HTTP mutation methods and injected
operation fields cannot start even the password-obscuring process. These checks
use local process stand-ins and never contact a file server.

This establishes regression coverage for these interfaces and workflows. It
does not remove write permissions from supplied credentials. Dedicated read-only
server credentials remain recommended.
