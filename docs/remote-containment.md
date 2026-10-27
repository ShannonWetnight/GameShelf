# Remote library containment review

The configured source path selects a library. It does not establish a remote
filesystem sandbox. A dedicated read-only account prevents modification, but
only server-side namespace/access restrictions prevent reads of other content
that the account can access. Local `os.OpenRoot` protections do not extend to
the network connectors.

## Confirmed implementation behavior

All protocols reject lexical parent traversal and invalid relative paths.
Downloads use the indexed file allowlist. Artwork, individual files, game ZIPs,
and Playlists share `copyRemote`. Length checks detect short transfers after
output begins; they do not authenticate file identity or prevent disclosure.
A replacement with the same size can satisfy a length check.

| Protocol | Connector behavior | Remaining boundary |
| --- | --- | --- |
| SMB | rclone SMB directory/object operations; the server applies share policy | A server may follow links within a share into a sibling of the configured subfolder. There is no application no-follow guarantee. |
| NFS | The native adapter omits non-regular/non-directory entries during listing; reads lstat each component, reject links, and use `O_NOFOLLOW` | Separate checks and path-based opens permit changes between operations. Recursive listing uses path-based `opendir` after `readdir`; it is not a handle-relative traversal. Configured-root ancestors and libnfs/server resolution also matter. |
| SFTP | rclone `skip_links` omits advertised links/special files during listing; server key is pinned | Direct object lookup uses stat/open rather than the listing's skip-links filter. Replacement files, parent directories, and the configured root may resolve through links. Host-key verification authenticates the server, not file containment. |
| WebDAV | HTTP collection listings and object GETs | A server can expose an alias as an ordinary resource. There is no portable filesystem symlink/no-follow metadata in this interface. |
| FTP | Server directory listings and file retrieval | Links can be advertised or resolved transparently by the server; behavior depends on server and listing format. |
| FTPS | Same file operations as FTP, over implicit TLS | TLS verifies transport/server identity, not filesystem containment. A server jail may confine the account while still exposing siblings of a configured subfolder. |

These are source-review observations, not a claim that every server supports or
exposes every link type. No single protocol-wide result should be inferred from
one server implementation.

## Focused correction: exact single-file reads

The previously registered upstream rclone `cat` accepts both files and
directories. An indexed file replaced by a directory could cause recursive
retrieval of unindexed children. `--count` applies to each object, so the final
application length check does not prevent those bytes from being sent.

The connector now registers its own narrow `cat`: create the parent filesystem,
look up exactly one named object, and open that object. Directory lookup fails
before any file content is emitted. It never lists/concatenates a directory.
Bounded reads are limited locally and offset/zero-length reads remain supported.
Legitimate game subfolders continue to work through their individually indexed
files; normal file contents and in-library paths are not broadly prohibited.

This fixes directory expansion. It does **not** make object lookup and open
atomic, reject every remotely resolved link, or bind a transfer to the identity
observed at scan time. Size/modtime rechecks or a second realpath check would
still leave races and would not provide portable containment for these backends.
The roadmap item therefore remains open.

## Isolated verification

Run `python3 scripts/network-containment.py gameshelf:candidate --report
reports/network-containment.json` on a Docker-enabled Linux host after building
the candidate image. Edge verification runs it automatically, alongside the
existing six-protocol smoke test and connector module unit tests.

The script creates a new internal network and a fresh server with `/fixture`
in tmpfs. There is no library/server/credential input. The app has no library
mount and exposes HTTP only on loopback through a separate disposable bridge.
Server commands mutate only this fixture. Containers, state volumes, CA volume,
and networks are removed afterward. Stable publishing is not invoked.

The configured source is `/fixture/Library` (or its protocol-relative equivalent),
with `/fixture/Outside` accessible to the fixture identity as a sibling. Samba
is deliberately allowed to follow in-share links; WebDAV/FTP rclone test servers
use the local backend's copy-links option; OpenSSH preserves SFTP link metadata
inside a `/fixture` jail; vsftpd retains a jail around `/fixture`.
These server choices deliberately test the difference between an export root
and a configured library subfolder. They are not production recommendations.

The JSON report records:

- Indexed game/file names and retrieval through file/directory links.
- Lexical traversal rejection.
- Artwork, file, ZIP, and Playlist outcomes before and after a file or entire
  game directory becomes a link; parent-directory link replacement as well.
- A mandatory regression check rejecting file-to-directory expansion, including
  cover reads and bytes emitted into incomplete archives.
- Replacement of a path after the first chunk of an active 32 MiB HTTP download;
  the opened stream must retain the original bytes.

Known server-resolved link reads are explicitly reported as `outside_content:
true`; successful characterization is **not** a containment pass. Interrupted ZIP
local entries are inspected even without a central directory. Dynamic cases
restore ordinary alias paths to avoid confusing an existing static-link leak
with the particular replacement under test. Covers are removed from this
disposable app's cache before each artwork probe.

The active-stream case does not synchronize the remote lookup/open gap, exercise
adversarial server responses, or prove immunity to in-place writes. Opened remote
handles may preserve identity after rename while the same file's bytes remain
mutable. No immutable snapshot or universal race-free guarantee is established.
Further work requires backend-specific handle-relative/no-follow operations or
server-enforced library namespaces, with explicit compatibility tradeoffs.
The unfs3 fixture exercises NFSv3, not NFSv4. NFSv4-specific resolution and other
server implementations still require separate isolated environments.

## Operational boundary

Use a share/export or jailed account whose visible namespace is limited to the
intended library, and review link/alias policy on that server. A jail around a
larger tree is not containment to a smaller configured subfolder. Restrict read
permissions on siblings too. Avoid changing remote paths while transfers are
active when snapshot consistency is required. Keep the server trusted and
credentials read-only; container restrictions do not revoke remote permissions.
