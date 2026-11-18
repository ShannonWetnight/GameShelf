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
| SMB | rclone performs directory and file operations under the server's share policy. | The client may follow SMB-reported symbolic links. The server may resolve other links internally, including into siblings of the configured subfolder. |
| NFS | The native adapter omits non-regular/non-directory entries during listing. Reads check each path component, use `O_NOFOLLOW`, and compare the opened file's type and identity before reading. | Earlier path checks and recursive listing still use separate path-based operations. Configured-root ancestors and libnfs/server resolution also matter. |
| SFTP | rclone `skip_links` omits advertised links/special files during listing; downloads now walk those listings from the source root before opening a file; server key is pinned | Separate listing/open operations still race. Configured-root changes or a server hiding link metadata remain outside this check. Host-key verification authenticates the server, not file containment. |
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

## Focused correction: SFTP download link policy

The first isolated run with OpenSSH confirmed that static links were skipped
during indexing but stable replacements after indexing were followed by direct
stat/open: file, artwork, ZIP, and Playlist reads exposed the sibling marker.
Both parent and entire game-directory replacements also exposed it. These were
disposable fixture files; no user library was tested.

SFTP reads now start at the configured source and walk each relative component
through `List` with `skip_links` enabled, then open the selected file object.
The file, parent directory, and game directory must all remain visible under the
same link policy used for discovery. Regression checks require the previously
observed stable link replacements to be rejected without outside content.
The check preserves the existing SFTP policy and ordinary nested files.

This is a pre-open check, not a race-free filesystem primitive. Replacing a
component between its listing and the later open can still bypass it. The
configured source root and its ancestors are not checked through this walk.
Opaque server aliases cannot be distinguished from ordinary resources here.
SMB/WebDAV/FTP/FTPS are not given an equivalent guarantee merely by applying
SFTP's backend-specific behavior to their listings.

## SMB share containment

For the documented sibling-access case, use a dedicated share rooted at the
library and restrict its account's filesystem permissions to that library. On
Samba, `read only = yes` protects against writes, `wide links = no` prevents
links from leaving the share, and `follow symlinks = no` also blocks links
within the share. With a larger share, disabling wide links alone still permits
in-share links into sibling directories. Disabling link following also prevents
intentional symlink-based collections. For such collections, expose only the
approved targets in a dedicated server-managed namespace. On Windows or a NAS,
review the platform's reparse-point, junction, referral, and ACL policies.

The pinned rclone SMB backend uses read-only opens. It exposes no no-follow
option, and its SMB dependency follows symbolic-link responses on ordinary
opens. A future SMB-specific client could reject those responses and reparse
points the server exposes, but it would still rely on the server for aliases
the server resolves internally. A separate stat before opening adds calls and
leaves a race. Keep the current SMB client for compatibility and exercise the
server restriction in the disposable smoke fixture. The fixture checks both a
regular nested source and a linked source on the same read-only share.

## NFS opened-file identity check

Before streaming, the adapter checks the opened handle with `nfs_fstat64`.
It requires a regular file with the same filesystem and file IDs as the final
`lstat`. It closes the handle before reading if the identity differs or the
server cannot return the attributes. This adds one metadata call per file.
Replacing a file in that interval can cause a read to fail and require a retry.

This checks for changes between the final path check and open, assuming stable
server file IDs. A path already redirected by the final check can still return
the same identity at open. The check cannot detect in-place writes or bind
reads to the indexed object.

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

The native handle check can also be tested without a server. On Linux with
libnfs development headers installed, run these commands from the repository root.

```sh
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
cc -Wall -Wextra -Werror -ffunction-sections -Wl,--gc-sections \
    tests/network-nfs-open.c -o "$fixture/network-nfs-open"
test "$("$fixture/network-nfs-open")" = ixt
```

## Operational boundary

Use a share/export or jailed account whose visible namespace is limited to the
intended library, and review link/alias policy on that server. A jail around a
larger tree is not containment to a smaller configured subfolder. Restrict read
permissions on siblings too. Avoid changing remote paths while transfers are
active when snapshot consistency is required. Keep the server trusted and
credentials read-only; container restrictions do not revoke remote permissions.

For NFS, export the library and limit the client's read permissions to that
export. For SFTP, root the jail at the library. For WebDAV, FTP, and FTPS, scope
the virtual root and server aliases to the library. A host-managed read-only
mount can use GameShelf's local source mode while the server still governs
remote access.
