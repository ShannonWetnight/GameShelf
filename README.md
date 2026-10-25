# GameShelf [![GitHub release](https://img.shields.io/github/v/release/shannonwetnight/gameshelf.svg?style=flat-square)](https://github.com/shannonwetnight/gameshelf/releases/latest) [![GHCR](https://img.shields.io/badge/GHCR-gameshelf-blue?logo=github)](https://github.com/users/shannonwetnight/packages/container/package/gameshelf) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![GameShelf Showcase](https://raw.githubusercontent.com/shannonwetnight/gameshelf/main/images/gameshelf_showcase.gif)

> **AI Workflow Notice**  
> Parts of GameShelf are developed with the assistance of AI tools to accelerate boilerplate generation, UI layout, and documentation drafting. All logic, architecture decisions, and final code have been reviewed and curated by the project maintainers. GameShelf is fully open-source (MIT licensed), and all contributors are welcome.

## Your games. Your shelf.

GameShelf turns a DRM-free collection into a read-only game library for your home network. Browse covers, find a game, and download its folder as a ZIP. Original files stay where they are. Display titles, favorites, edited artwork, and settings live separately in application data.

It is designed for a small LAN, typically 1–10 people, without accounts, game launchers, or a database service. GameShelf does not supply games or bypass DRM. Anyone with access can download files and change shared library settings; control access through your network or reverse proxy.

## Contents

- [Install with Docker](#install-with-docker)
- [First-time setup](#first-time-setup)
- [Choosing library locations](#choosing-library-locations)
- [Browse, download, and customize](#browse-download-and-customize)
- [Settings and defaults](#settings-and-defaults)
- [Themes](#themes)
- [Backup, import, and recovery](#backup-import-and-recovery)
- [Permissions and deployment](#permissions-and-deployment)
- [Troubleshooting](#troubleshooting)
- [Development and releases](#development-and-releases)
- [Responsible use](#responsible-use--distribution)

## Install with Docker

Use [Docker Engine](https://docs.docker.com/engine/install/) with [Compose](https://docs.docker.com/compose/install/). You need a reachable file server or a games folder to share with the container.

```yaml
services:
  gameshelf:
    image: ghcr.io/shannonwetnight/gameshelf:latest
    container_name: gameshelf
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - gameshelf-data:/data
      # Optional local library; choose /library during setup:
      # - /path/to/your/games:/library:ro
    security_opt:
      - no-new-privileges:true

volumes:
  gameshelf-data:
```

Save as `compose.yaml`, run `docker compose up -d`, and open **http://your-server:8080**. Docker creates the named data volume automatically; no host data folder is needed. Direct network libraries do not need the optional game-folder mapping.

Alternatively:

```bash
docker run -d \
  --name gameshelf \
  --restart unless-stopped \
  --security-opt no-new-privileges:true \
  -p 8080:8080 \
  -v gameshelf-data:/data \
  ghcr.io/shannonwetnight/gameshelf:latest
```

Keep the same data volume across container recreations. To choose host storage, replace `gameshelf-data:/data` with `/your/app-data/gameshelf:/data` and grant write access. Removing the volume deletes saved application data; recreating only the container does not.

GameShelf always listens on **8080 inside the container**. Change only the host side if occupied, for example `8090:8080`. No environment variables are required. To compare `latest` and `edge`, use separate container names, host ports, and data volumes. Do not share their writable data volume.

## First-time setup

The welcome screen appears when no library or completed setup is saved. It waits for your choices without repeatedly scanning a missing `/games` folder.

1. **Your Games:** choose **Folder** for an existing container mapping, or **Network** for a NAS or file server. Mix up to 16 locations, each containing one subfolder per game. Select **Continue** when ready.
2. **Your Shelf:** choose a theme, a scan schedule, and whether to see the quick tour. Select **Continue** to save and open the library. Weekly scanning, **168 hours**, is the default.

Already have a backup? **Import Data** on the first step previews a GameShelf backup ZIP. Restore server settings, library state, and uploaded covers to bypass the setup steps. Passwords are not backed up: sign in to protected shares again afterward. [See recovery details](#backup-import-and-recovery).

Not ready? The header **settings cog → Set Up Later** opens an empty shelf. Add locations later in **Settings → Advanced → Data and Diagnostics → Library Sources**. This choice survives restarts. **Advanced Data and Diagnostics → Finish First-Time Setup** reopens the wizard only when setup was skipped or remains unfinished.

The optional tour begins with game controls and the Home logo, then covers search, sorting, views, the dice picker, Playlist, and Settings. **Ignore** skips the invitation. Once started, exiting asks for confirmation. Replay it using **Settings → Appearance → Quick tour**. Motion respects animation settings and the device's reduced-motion preference.

A valid initial `GAMESHELF_ROOT` with its matching mount skips setup. Existing saved configuration is retained. The setup logo remains in its normal header position and is disabled until setup finishes.

## Choosing library locations

Choose **Folder** if Docker already shares the games with GameShelf. Choose **Network** to connect directly to a file server. Both work together. Add, edit, test, or remove locations later in **Advanced Settings → Library Sources**. Removal requires confirmation and removes only configuration, never the original files. Save the Library Sources menu to apply your choices.

### Folder shared with the container

Uncomment the optional mapping in Compose, replacing its left side with the games folder on your Docker host:

```yaml
    volumes:
      - gameshelf-data:/data
      - /mnt/my-games:/library:ro
```

Recreate the container, then choose **Folder → Browse → /library → Select**. Enter the container path `/library`, rather than `/mnt/my-games`. Browse offers permitted library mounts and excludes system and application-data folders.

A network share already mounted on the Docker host works the same way. The `:ro` mapping keeps the original game files read-only.

### Direct network connection

Choose **Network**, select a protocol, enter a location, and supply credentials if needed. **Test Connection** checks without adding it. **Add Location** checks and adds in one action. The standard **save icon** checks and applies edits. **More options** offers a friendly name and protocol-specific controls.

| Type | Example location | Authentication and options |
| --- | --- | --- |
| SMB | `smb://nas.example/games` | SMB 2/3; username/password and optional Windows domain. Guest shares may not need credentials. `\\nas.example\games` and `nas.example/games` also work. |
| NFS | `nfs://nas.example/export/games` | Automatic NFS 4 then NFS 3, or select a version. Numeric UID/GID default to 10001. The export must permit this client and identity. |
| SFTP | `sftp://nas.example:22/games` | Password authentication and a pinned SSH host key. Verify the fingerprint against the server before trusting it; changed keys need approval again. |
| WebDAV | `https://nas.example/webdav/games/` | HTTP or HTTPS with optional username/password. Prefer HTTPS. |
| FTP | `ftp://nas.example:21/games/` | Optional username/password; traffic is unencrypted. |
| FTPS | `ftps://nas.example:990/games/` | Implicit TLS with a trusted certificate. Explicit STARTTLS on port 21 is not supported. |

Connections originate from the container, so check server reachability, DNS, and firewall access there. No privileged mode, FUSE, or kernel mounts are needed. NFS may require an export policy allowing unprivileged client ports. Kerberos, SSH private keys, and client certificates are not configurable in the app. SFTP listings omit symbolic links and special files.

Use a server account restricted to reading the intended folders. GameShelf's connectors issue read operations; server permissions determine what the account can access. Passwords are encrypted in saved settings using a private key in the data volume and are never returned to the browser. A blank password when editing an existing location keeps its saved password.

### Organize the collection

Each direct child folder becomes a game. Its files and subfolders are included in downloads:

```text
Games/
  Amber Circuit/
    cover.png
    Installer/
    Manuals/
  Moonlit Valley/
    cover.jpg
    Installer/
    Extras/
```

GameShelf scans metadata and streams files when requested; it does not copy the whole collection into `/data`. Multiple sources and duplicate game-folder names receive separate stable IDs and artwork associations.

### Offline servers

Previously indexed network games remain visible with an offline notice, including after restarting with the same data volume. Titles, favorites, dates, sizes, and file lists remain browsable. Downloads require reconnection and refresh; a Playlist containing offline games cannot download. Uploaded artwork remains available. Folder artwork is available only while it remains in the bounded cover cache.

A successful scan replaces that source's listing, including deletions. Removing a source or changing its protocol/address discards its cached listing. Games never indexed cannot appear while offline.

The disposable snapshot is `network-index.json` in saved data, limited to 64 MiB. Missing or invalid snapshots are ignored and logged. Cover caching is bounded to 20 MiB per image, 256 MiB total, and seven days. Exports exclude the network index: a restored server needs an online scan to rebuild it.

## Browse, download, and customize

- **Home:** the console logo returns to the full grid; the GameShelf text refreshes the library.
- **Find games:** search by title, sort by title/size, or filter Favorites and Recently Added. `/` focuses search; Escape clears it. **All** clears the sort/filter.
- **Views:** switch between cover grid and list. Hover for favorite, download, Playlist, and information controls. Click a list thumbnail for a larger preview; click anywhere to close it.
- **Favorites:** adding is immediate; removing asks for confirmation. Favorite stars stay visible by default and favorite games appear first.
- **Dice:** shuffle to a random game, roll again, or return to the shelf. Dice and card shuffle use the same duration.
- **Downloads:** download a whole game as a ZIP. The information panel's file count opens individual file downloads with sizes.
- **Playlist:** use **+** to collect up to 50 games, review using the header Playlist icon, and download one `gameshelf-playlist.zip`. Each game has its own folder. Estimated size is uncompressed. The selection stays in this browser until cleared. Removal and clearing require confirmation. Disable Playlist downloads to hide its controls everywhere.
- **Details:** edit display titles or covers without renaming original files. **Reset Metadata** offers a confirmed reset of title, cover override, and favorite state, preserving the original first-seen date.

### Cover art

Open **Add Cover** or **Edit Cover** in game details. Upload an image or choose a PNG, JPEG, GIF, or WebP from the game's folder. Adjust crop, zoom, rotation, and tilt, then use the save icon. The editor stays above the details panel and returns there after saving or closing. Cancelling the computer's file picker keeps the editor open.

Edited covers are 600×900 PNGs in application data. They take priority over these automatically detected files at a game's root: `cover.jpg`, `cover.jpeg`, `cover.png`, `folder.jpg`, `folder.jpeg`, `folder.png`. Other supported filenames can be selected through the folder chooser. Missing artwork uses the GameShelf placeholder unless disabled.

A 600×900 poster is a good starting point. Poster (2:3), portrait (3:4), square, landscape (4:3), and widescreen (16:9) covers preserve their proportions within a stable 2:3 frame. Any unused area uses a soft cover-derived backdrop, including unusual poster sizes and list thumbnails. **Stretch covers to fill** fills frames without preserving proportions. The stretch icon beside Edit Cover can enable or disable this for one game, overriding the browser-wide setting; Reset Metadata’s cover option clears this override. Static titles sit below the frame without resizing the image.

## Settings and defaults

Open the header cog. **Basic / Advanced** reveals extra controls. Display preferences are stored in this browser; metadata, sources, schedules, and logging are shared by the server. Immediate changes show a confirmation banner. Configuration menus apply changes with the standard save icon.

| Setting | Default | Location / behavior |
| --- | --- | --- |
| Theme | System | Appearance; follows the device. A dark system uses GameShelf Classic. |
| Stretch covers to fill | Off | Advanced Library View; override individual titles with the stretch icon beside Edit Cover. Per-game overrides are shared metadata and included in backups. |
| Animation speed | 1.10× | Advanced Appearance; 0 stops motion, maximum 3.0×. |
| Animate loaded game tiles | On | Appearance; independent of animation speed. |
| Show button hints | On | Appearance. |
| Show game titles | Off | Appearance; static banners below covers. |
| Show placeholder images | On | Appearance; otherwise theme-colored empty covers. |
| Enable Playlist downloads | On | Library View. |
| Show favorites first | On | Library View. |
| Show images in list view | On | Library View. |
| Show favorited game stars on top | On | Library View; otherwise stars show with hover controls. |
| Card depth | On | Library View; soft shadows and raised edges. |
| Recently Added range | 7 days | Advanced Library View → Configure. |
| Click to expand image in list view | Single-click | Advanced Library View; Single-click, Double-click, or Disabled. Requires list images. |
| List tile opacity | 80% | Advanced Library View; 0–100%, keeping text and controls visible. |
| Show game names on hover | On | Advanced Library View; temporarily disabled when static titles are on. |
| Automatic refresh | 168 hours | Advanced Data and Diagnostics → Refresh Interval; 0 for manual only. |
| Backup selections | All selected | Data and Diagnostics → Export Data. |

**Application Logs** is visible in Basic settings; **Configure** is Advanced. View, filter, copy, or download the process's log snapshot. Without **Customize logging**, system, library, and error events stay enabled. Customization allows individual system, library, error, request, scan, and download categories. Default retention has no age limit and is bounded to 10 MB, with optional age and size overrides. System logging records server and display-setting changes without credential values. Logs are kept in process memory and do not survive a restart.

**Reset All Settings → Wipe** asks for confirmation and resets browser preferences and server settings. It does not delete game files, game metadata, or uploaded covers. Restart if resetting changes the saved-data path. Without an initial library, setup is offered again.

**Library Sources → Saved data location** selects a writable subdirectory within the original data mount. Changing it does not move existing data: copy metadata and artwork before restarting. Server configuration remains under the original data mount.

## Themes

| Theme | Appearance and motion |
| --- | --- |
| Randomize | Chooses one existing theme each time the app is opened, keeping it stable for that visit. |
| System, GameShelf Classic, Light, Dark | Standard branding; System follows the device. |
| Retro Arcade | Purple arcade colors, warm aged-yellow text, pointer-lit dazzling stars. |
| Neon Mirage | Cyan/pink vaporwave glow, perspective grid, CRT motion. |
| Cartridge Gray | Classic gray console surfaces and red accents. |
| Deep Space | Randomized nebulae, drifting stars, starry cover overlays. |
| Ion Grid | Teal science-fiction panels and scanning light. |
| Rose Quartz | Pink/pearl palette and pointer-following twinkling glitter. |
| Midnight | Black surfaces and a soft flashlight revealing darkened covers under the pointer. |
| Lattice | Green/ivory geometry and moving threads of light. |
| Rain | Cool animated rainfall. |
| Midnight Storm | Dark storm colors and denser rain. |
| Autumn Rain | Warm fall colors, faster rain, falling leaves. |

Expressive themes recolor the logo. Rain also falls inside hovered covers, parts around the pointer like an umbrella, and splashes near the bottom. Theme changes fade between palettes. Effects respect reduced motion and animation speed; set speed to 0 to stop motion.

## Backup, import, and recovery

Use **Data and Diagnostics → Export Data**. Choose saved library state, server settings, recent logs, and available covers. These are app backups, **not backups of game installers or original game files**.

**Server settings** includes locations and stable source IDs, usernames, protocol options, refresh schedule, logging, saved-data configuration, setup state, and the exporting browser's supported appearance/library preferences. A notice appears for shares requiring sign-in: **passwords and the encryption key are never exported**. Treat archives as private because they contain locations, usernames, and possibly logs.

To restore on a fresh container:

1. Attach persistent data storage and start GameShelf.
2. Select **Import Data** on the welcome screen and choose the ZIP.
3. Review state, server settings, and uploaded covers; acknowledge replacement of selected app data and restore.
4. Open **Advanced Settings → Library Sources**, enter protected shares' passwords, and save. Refresh to rebuild the network index.

Setup imports use this container's current data location, rather than a path on the old server. Local paths from the backup must be mapped at the same container paths. If unavailable, deselect **Server settings**, import state/covers, and add locations manually. Restore network settings when possible to retain source IDs and metadata associations.

On an existing server, **Restore Data** offers the same preview and selective replacement. Uploaded covers restore; detected folder covers and old logs are not written back to game folders or process logs. Appearance preferences apply when Server settings is selected. Source changes apply live; a changed saved-data location requires a restart. Protected shares remain offline until signed in again.

For a complete storage migration **including encrypted passwords**, stop GameShelf and copy the whole data volume, including hidden files and its private key. Keep that copy secure. Exported ZIPs intentionally do not provide credential recovery.

## Permissions and deployment

The image runs as unprivileged UID/GID **10001:10001**. It must read mapped libraries and write `/data`; it does not change their ownership. Use `:ro` for game mappings and retain `no-new-privileges:true`. You can also add:

```yaml
    read_only: true
    cap_drop:
      - ALL
```

The data volume must stay writable. For a host folder requiring another identity, use Compose `user: "1000:1000"` or a supplemental numeric group with `group_add: ["2000"]`. These are Docker settings; the app does not interpret `PUID`/`PGID`. ACLs, rootless Docker, user namespaces, and SELinux may affect host access.

| Optional environment variable | Default | Purpose |
| --- | --- | --- |
| `GAMESHELF_ROOT` | Unset | Initial mapped library folder; unnecessary for interactive setup. |
| `GAMESHELF_DATA_DIR` | `/data` | Original writable application-data mount. |

`GAMESHELF_ADDR` is no longer used; the internal port is always 8080. Configure refresh in the app. Legacy `GAMESHELF_REFRESH_INTERVAL` is read only as an initial compatibility setting.

### Reverse proxy and access control

Traefik or another proxy can serve GameShelf. On a shared Docker network, use **http://gameshelf:8080** as the backend regardless of the published host port. This minimal Traefik file-provider example assumes an existing `https` entry point and TLS setup:

```yaml
http:
  routers:
    gameshelf:
      entryPoints: [https]
      rule: "Host(`games.example.com`)"
      tls: {}
      service: gameshelf
  services:
    gameshelf:
      loadBalancer:
        servers:
          - url: "http://gameshelf:8080"
```

Restrict access through your network or proxy. Forward-auth integrations such as Authelia, Tinyauth, or Authentik can protect the app. GameShelf has no native accounts, SSO, profiles, or per-user permissions. Setup is not an authentication boundary.

### Local integrations

`GET /api/stats` returns `gameCount`, `fileCount`, `totalSizeBytes`, `coveredGameCount`, and `lastIndexedAt` (UTC RFC 3339). Counts reflect indexed regular files, including folder covers, but exclude uploaded covers. Uploads update cover availability. `lastIndexedAt` is empty until a successful scan. This endpoint does not expose host paths.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No folders in Browse | Add a read-only mapping, recreate the container, and choose its container path. Or use Network. |
| Connection fails | Check protocol, share/export path, credentials, DNS, and firewall access from the container. Review Application Logs. |
| NFS access denied | Check export access, UID/GID, version, and unprivileged-port policy. |
| SFTP key warning | Verify the displayed fingerprint with the server administrator before trusting it. |
| Settings disappear after recreation | Reattach the same data volume and check write permissions. |
| Restored shares are offline | Enter their passwords again and refresh; exports omit passwords. |
| Library offline after restart | Cached entries remain browsable. Reconnect and refresh before downloading. |
| Wrong external port | Change only the host side, for example `8090:8080`; proxy backends still use 8080. |
| Cover not detected | Use a recognized root-level filename above, or choose an image in Edit Cover. |

## Development and releases

GameShelf uses Go and static browser assets. Docker includes a restricted [rclone](https://rclone.org/) connector for SMB/SFTP/WebDAV/FTP/FTPS and a read-only [libnfs](https://github.com/sahlberg/libnfs) adapter. Versions and notices ship under `/usr/share/licenses/gameshelf-network`.

Source builds need **Go 1.27.3 or later**, `connectors/rclone` built as `rclone`, and `native/network-nfs.c` compiled with libnfs as `/app/gameshelf-nfs`. Docker handles these steps automatically. Tests cover server behavior, browser flows, protocol fixtures, container restrictions, and dependency/image security.

This Edge branch contains development tests and packaging. Use **Edge tests and prerelease** in Actions for test packages and optional prereleases. Promote reviewed application changes and notes to main individually; keep the test harness on Edge. See the [release guide](.github/RELEASING.md) and [roadmap](ROADMAP.md).

## Responsible Use & Distribution
GameShelf is a general-purpose file indexing and download utility. While it is designed to organize and serve locally stored game files, it does not enforce or restrict the type of content being served. As such, it can be used to distribute any files accessible within its configured root directory.

By installing, configuring, or using GameShelf, you accept full legal responsibility for how the software is used and for any content made available through it.

### User Responsibility
- Use GameShelf only with content you own, are licensed to distribute, or are otherwise legally permitted to share
- Comply with all applicable local, national, and international laws, including but not limited to copyright and intellectual property laws
- Do not use GameShelf to knowingly facilitate illegal distribution, piracy, or unauthorized sharing of copyrighted material

### No Liability
The GameShelf project, its contributors, and maintainers:
- Do not provide content
- Do not monitor or control user deployments
- Assume no responsibility or liability for how the software is used or what files are distributed through it

GameShelf is provided “as is”, without warranty of any kind, and is intended for personal, lawful, and responsible use only.

> [!WARNING]
> If you choose to expose GameShelf publicly (for example, via port forwarding, reverse proxies, or tunneling services), you do so entirely at your own risk and are solely responsible for the consequences of that exposure.
