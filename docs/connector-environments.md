# Connector subprocess environments

GameShelf constructs a fresh, non-nil environment for every network subprocess.
Only exact allowlisted names are copied; an empty environment never falls back
to inheriting the application environment. This reduces accidental exposure of
application secrets and unrelated source credentials.

## Required configuration

| Process | Inherited configuration | Operation-specific inputs |
| --- | --- | --- |
| All four process paths | `TZ`, `TMPDIR`, `TMP`, `TEMP`, `SYSTEMROOT`, `WINDIR` when set | Runtime time zone, temporary storage and Windows system paths; absent values use platform defaults |
| rclone transfer | `LOCALDOMAIN`, `RES_OPTIONS`, `HOSTALIASES`; WebDAV/FTPS also receive `SSL_CERT_FILE`, `SSL_CERT_DIR`; WebDAV also receives `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase equivalents | A fresh `RCLONE_CONFIG_GS_*` map from the selected source, with `--config` pointing to the null device |
| Native NFS helper | `LOCALDOMAIN`, `RES_OPTIONS`, `HOSTALIASES` | Operation, destination, NFS version and UID/GID through arguments; no source password |
| `rclone obscure -` | No network, certificate, proxy or source configuration | Only the selected password on stdin; obscured output goes to the transfer environment |
| `ssh-keyscan` | `LOCALDOMAIN`, `RES_OPTIONS`, `HOSTALIASES` | Validated host, port, timeout and key types through arguments; no password or agent |

The resolver variables preserve libc resolver configuration where the platform
supports it. Pure Go binaries may use only system resolver files. Go debug/runtime
overrides are deliberately excluded rather than forwarding arbitrary `GODEBUG`
settings that can change security behavior. TLS uses the system CA store by
default; custom CA paths remain supported for WebDAV and implicit FTPS. Proxy
settings are retained only for WebDAV's HTTP transport. The other backends use
direct protocol connections; forwarding unrelated proxy names does not add proxy
support. Empty allowlisted values remain empty.

Passwordless SFTP retains its existing `SSH_AUTH_SOCK` fallback. Only that
transfer receives the socket, never password-authenticated SFTP, NFS, password
obscuring or key discovery. An agent is a shared signing capability: its identities
are not isolated per source. Use dedicated password credentials or a dedicated
restricted agent when this distinction matters. The source's pinned host key
continues to apply.

Ambient `RCLONE_*`, cloud credentials, application variables, `HOME`, XDG
configuration, loader hooks and arbitrary runtime variables are excluded.
Per-source passwords are still passed as rclone-obscured environment values;
obscuring is reversible and is not encryption or an OS secrecy boundary.
No credential values should be logged.

## Verification

`network_environment_test.go` uses disposable sentinel values to check the exact
allowlist, explicit empty values, selected credentials, source-to-source cleanup,
passwordless agent compatibility and actual subprocess environments. Local shell
stand-ins verify password-obscuring, transfer/NFS and host-key discovery paths
without contacting any shares. Existing operation rejection tests retain their
process-call checks using a fixture-local log path rather than an inherited
application variable.

The Edge PR workflow also runs the real SMB, NFS, SFTP, WebDAV, FTP and FTPS smoke
fixtures and isolated containment cases. FTPS uses a fixture CA through
`SSL_CERT_FILE`; the app runs unprivileged with all capabilities dropped, a
read-only root filesystem and `no-new-privileges`. Sentinel tests do not establish
that arbitrary proxies, agent servers or resolver implementations work; they
verify which settings reach each process. These test servers and credentials are
disposable. Production shares are not used.

## Remaining boundaries and follow-up

Environment filtering does not isolate processes from files, sockets, the parent
UID or the container's network. System resolver/CA files remain readable.
Executables are still resolved through the trusted application's PATH (or an
explicit helper path); filtering the child's environment does not change that
lookup. Keep executable directories root-owned. Source credentials and allowed
proxy URLs may contain secrets visible to processes with sufficient OS access.
Temporary known-host files remain in the application data directory with the
existing cleanup and permissions.

Approved destinations are not enforced by this change. DNS changes, server-side
aliases and HTTP redirects require a separate destination policy. Network-level
egress restrictions can help, but must account for DNS, SMB, NFS/rpcbind,
FTP passive ports, proxies and redirects. The existing read-only operation
allowlist and protocol authentication/host-key checks remain in force; remote
account permissions still determine server-side access.

The fixture's existing non-root execution, capability removal, read-only root
and `no-new-privileges` work without privileged containers. Per-helper UIDs,
Landlock filesystem rules, tighter seccomp filters and process/resource limits
could reduce local impact further, but require separate compatibility tests and
an explicit policy for CA files, DNS, known-host files, agent sockets and runtime
threads. They are not enabled or claimed as tested by this change. A separate
credential broker would be needed to avoid giving a connector the selected
credential itself. The broader roadmap isolation item remains open.
