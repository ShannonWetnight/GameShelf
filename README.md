# GameShelf [![GitHub release](https://img.shields.io/github/v/release/shannonwetnight/gameshelf.svg?style=flat-square)](https://github.com/shannonwetnight/gameshelf/releases/latest) [![GHCR](https://img.shields.io/badge/GHCR-gameshelf-blue?logo=github)](https://github.com/users/shannonwetnight/packages/container/package/gameshelf) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![GameShelf Showcase](https://raw.githubusercontent.com/shannonwetnight/gameshelf/main/images/gameshelf_showcase.gif)

> **AI Workflow Notice**  
> Parts of GameShelf are developed with the assistance of AI tools to accelerate boilerplate generation, UI layout, and documentation drafting. All logic, architecture decisions, and final code have been reviewed and curated by the project maintainers. GameShelf is fully open-source (MIT licensed), and all contributors are welcome.

## Your games. Your shelf.

GameShelf turns a DRM-free collection into a read-only game library for your home network. Browse covers, find a game, and download its folder as a ZIP. Original files stay where they are. Display titles, favorites, edited artwork, and settings live separately in application data.

It is designed for a small LAN, typically 1–10 people, without accounts, game launchers, or a database service. GameShelf does not supply games or bypass DRM. Optional Family Controls restrict shared settings and actions with a PIN or disable them entirely. Protect access to the app through your network or an authenticated reverse proxy. Security is a core requirement: server-side enforcement, confined read-only library access, protected secrets, and automated security checks are part of the application.

## Contents

- [Install with Docker](#install-with-docker)
- [First-time setup](#first-time-setup)
- [Choosing library locations](#choosing-library-locations)
- [Browse, download, and customize](#browse-download-and-customize)
- [Settings and defaults](#settings-and-defaults)
- [Family Controls](#family-controls)
- [Library Manager](#library-manager)
- [Library Health](#library-health)
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

Not ready? The header **settings cog → Set Up Later** opens an empty shelf. Add locations later in **Settings → Advanced → Data and Diagnostics → Library Manager → Library Sources**. This choice survives restarts. **Basic Data and Diagnostics → Finish First-Time Setup** reopens the wizard only when setup was skipped or remains unfinished.

The optional tour begins with game controls and the Home logo, then covers search, sorting, views, the dice picker, Playlist, and Settings. **Ignore** skips the invitation. Once started, exiting asks for confirmation. Replay it using **Settings → Appearance → Quick tour**. Motion respects animation settings and the device's reduced-motion preference.

A valid initial `GAMESHELF_ROOT` with its matching mount skips setup. Existing saved configuration is retained. The setup logo remains in its normal header position and is disabled until setup finishes.

## Choosing library locations

Choose **Folder** if Docker already shares the games with GameShelf. Choose **Network** to connect directly to a file server. Both work together. Add, edit, test, or remove locations later in **Advanced Settings → Library Manager → Library Sources**. Removal requires confirmation and removes only configuration, never the original files. Save the Library Sources menu to apply your choices.

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

The configured network folder is a path selection, not a server-side sandbox. Servers may resolve links or aliases outside that folder, and paths can change after indexing. Restrict the account, share, export, or server jail to the intended library; read-only permissions alone do not restrict which files can be read. See the [remote containment review](docs/remote-containment.md) for protocol differences and remaining race limitations.

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

A 600×900 poster is a good starting point. Poster (2:3), portrait (3:4), square, landscape (4:3), and widescreen (16:9) covers preserve their proportions within a stable 2:3 frame. Any unused area uses a soft cover-derived backdrop, including unusual poster sizes and list thumbnails. **Stretch covers to fill** fills frames without preserving proportions. The stretch icon inside Edit Cover can enable or disable this for one game, overriding the browser-wide setting; Reset Metadata’s cover option clears this override. Static titles sit below the frame without resizing the image.

## Settings and defaults

Open the header cog. **Basic / Advanced** reveals extra controls. Dropdowns share app-themed, joined option lists with keyboard and type-ahead support. Expandable menus resize smoothly in both directions, respecting animation speed and reduced motion. Display preferences are stored in this browser; metadata, sources, schedules, and logging are shared by the server. Immediate changes show a confirmation banner. Configuration menus apply changes with the standard save icon. Family Controls can require a PIN, disable, or hide individual controls.

| Setting | Default | Location / behavior |
| --- | --- | --- |
| Theme | GameShelf Classic | Appearance; System follows the device using Light or Dark. |
| Stretch covers to fill | Off | Advanced Library View; override individual titles with the stretch icon inside Edit Cover. Per-game overrides are shared metadata and included in backups. |
| Animation speed | 1.10× | Advanced Appearance; 0 stops motion, maximum 3.0×. |
| Animate loaded game tiles | On | Appearance; independent of animation speed. |
| Show button hints | On | Appearance. |
| Show game titles | Off | Appearance; static banners below covers. |
| Show placeholder images | On | Appearance; otherwise theme-colored empty covers. |
| Enable Playlist downloads | On | Library View. |
| Show favorites first | On | Library View. |
| Show images in list view | On | Library View. |
| Show favorited game stars on top | On | Library View; otherwise stars show with hover controls. |
| Card depth | On | Advanced Appearance; soft shadows and raised edges. |
| Recently Added range | 7 days | Advanced Library View → Configure. |
| Click to expand image in list view | Single-click | Advanced Library View; Single-click, Double-click, or Disabled. Requires list images. |
| List tile opacity | 80% | Advanced Library View; 0–100%, keeping text and controls visible. |
| Show game names on hover | On | Advanced Library View; temporarily disabled when static titles are on. |
| Automatic refresh | 168 hours | Advanced Data and Diagnostics → Library Manager → Refresh Interval; 0 for manual only. |
| Backup selections | All selected | Data and Diagnostics → Export Data. |

**Application Logs** is visible in Basic settings; **Configure** is Advanced. View, filter, copy, or download the process's log snapshot. Without **Customize logging**, system, library, and error events stay enabled. Customization allows individual system, library, error, request, scan, and download categories. Default retention has no age limit and is bounded to 10 MB, with optional age and size overrides. System logging records server and display-setting changes without credential values. Each log download appends its export event as the last line of the downloaded snapshot without resizing the open log window. Logs are kept in process memory and do not survive a restart.

**Reset All Settings → Wipe** asks for confirmation and resets browser preferences and server settings. It does not delete game files, game metadata, or uploaded covers. Restart if resetting changes the saved-data path. Without an initial library, setup is offered again. Family Controls and the PIN are retained; Wipe cannot remove their protection. If setup is skipped afterward, Finish First-Time Setup stays visible in Basic settings.

**Library Manager → Library Sources → Saved data location** selects a writable subdirectory within the original data mount. Changing it does not move existing data: copy metadata and artwork before restarting. Server configuration remains under the original data mount.

## Family Controls

Open **Settings → Advanced → Data and Diagnostics → Family Controls → Configure**. Create and confirm a **4-digit PIN**, then choose the access level and visibility of each setting or action:

| Access | Behavior |
| --- | --- |
| Allow | Available normally; the default for every action. |
| Require PIN | Prompts for the family PIN before the action. A successful entry unlocks only the requested actions in that browser for the chosen remembrance period. |
| Disable | Greys the controls out. The server also rejects protected API operations; entering the PIN does not override Disable. |

The **Show** checkbox controls whether an action appears. Hiding is a presentation choice; choose Require PIN or Disable as well when restricting it. Configure individual appearance/library settings, sources, storage, refresh, logs, health monitoring, backup/restore, setup, covers, titles, favorites, metadata resets, Playlist actions, and downloads. Display preferences and Playlist selections live in each browser; their controls follow the policy. Server operations enforce the policy independently of the interface. Family Controls are grouped by Appearance, Library View, Library Manager, Data and Diagnostics, and game actions. The **Category** column places settings in Basic or Advanced. Family Controls itself can be moved into Basic. **Settings menu** and **Advanced settings tab** each support Allow or Require PIN; they cannot be hidden or disabled, which preserves owner recovery. Library Manager has a shared access rule in addition to any existing rules on its tools. Hiding a control does not change its access mode.

Once a PIN exists, managing, changing, or removing it requires the current PIN. **Remove PIN** requires confirmation. Changing the PIN signs out **every browser, including the browser changing it**. Enter the new PIN before opening a protected control or Family Controls again. PIN errors use an alert banner; the compact prompt hides the text caret while retaining keyboard input. Reset and restore operations also check the permissions for the settings and metadata they would replace, so they cannot bypass restrictions.

The PIN is salted and hashed using PBKDF2-HMAC-SHA256 with 600,000 iterations, following [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). It is stored privately in `.family-pin.json` under the original data mount. The Guardian PIN, its verifier, and unlock cookies never appear in logs or backup ZIPs. Profile verifiers are included in profile backups; use the optional backup passphrase to encrypt them (see below). Attempts are limited to six per minute per connected client address and thirty per minute across the server. Unlock cookies are HttpOnly and SameSite Strict, and Secure on direct HTTPS connections. Rejected attempts and policy changes produce credential-free system/error events. A corrupt private record blocks protected operations instead of silently allowing them.

**Use HTTPS when entering a PIN or share credentials**, and put authentication in front of the app when it is accessible beyond your trusted household network. A 4-digit Guardian PIN protects shared actions. Optional local profiles add personal shelves, but PINs do not provide the strength of a full account login. Behind a proxy, attempt limits use the proxy's connected address rather than trusting arbitrary forwarded headers.

Backups contain the rules, never the PIN secret. Restoring onto an already protected server preserves its existing PIN and rules. A fresh restore keeps imported restrictions: Disable remains disabled, and Require PIN actions wait for you to create a new PIN in Family Controls. The setup cog also offers Family Controls. If a fresh import includes a locked menu but no PIN secret, opening it offers the PIN configurator before allowing the protected menu. The setup cog also offers Family Controls. For a complete migration, copy the full data volume securely, including hidden files. If the PIN is forgotten, a server owner with direct data-volume access can stop GameShelf, remove `.family-pin.json` and the `access` field in `server-settings.json`, and restart. This is an offline owner recovery procedure, not an in-app bypass.

## Library Manager

**Advanced Settings → Data and Diagnostics → Library Manager** groups Library Sources, Library Health, and Refresh Interval. Each opens a focused submenu and returns to its parent when closed. Guardians can protect the manager as a whole and keep existing tool-specific rules.

Manual refresh has a **ten-second server-wide quiet period**, and another manual discovery cannot queue while one is already running. A repeated request receives HTTP 429 with Retry-After; cached library browsing continues normally. Automatic scheduled scans follow their own interval.

## Library Health

Open **Settings → Advanced → Data and Diagnostics → Library Manager → Library Health → View Status**. Each source shows its last check, last successful connection check, game-folder count, and a status bubble:

- **Green — Healthy:** the location is readable.
- **Yellow — Degraded:** a previously readable location failed one or two checks, or has not yet been checked.
- **Red — Critical:** unreadable with no successful check yet, or three consecutive failures.

**Check Now** probes the configured locations without changing files or rebuilding the catalog. A successful check clears the failure count. Offline cached games stay visible. Open **Monitoring options → Configure** to enable automatic checks and choose a whole-second interval from 30 seconds to one day; the default is **five minutes**. Checks read folder listings rather than requiring privileged network pings. Connection and mounted-folder probes time out, with bounded work for an unresponsive mounted filesystem.

The newest 500 source check events are saved in `library-health.json`. Export or restore this history independently; monitor options are included in server settings. **Recent checks → View Logs** opens the saved health log with copy/download controls. The **Library health** category is also available in Application Logs and its logging configurator; it is enabled by default and can be customized. The check-interval field is disabled while automatic monitoring is off. Family Controls can protect viewing/checking status separately from changing monitoring options.

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

Use **Data and Diagnostics → Export Data**. Choose saved library state, server settings, recent logs, library health history, and available covers. These are app backups, **not backups of game installers or original game files**.

**Server settings** includes locations and stable source IDs, usernames, protocol options, refresh schedule, logging, health monitoring, family-control rules, saved-data configuration, setup state, and the exporting browser's supported appearance/library preferences. A notice appears for shares requiring sign-in: **passwords, the encryption key, and PIN secrets are never exported**. Treat archives as private because they contain locations, usernames, and possibly logs.

To restore on a fresh container:

1. Attach persistent data storage and start GameShelf.
2. Select **Import Data** on the welcome screen and choose the ZIP.
3. Review state, server settings, health history, and uploaded covers; acknowledge replacement of selected app data and restore.
4. Open **Advanced Settings → Library Manager → Library Sources**, enter protected shares' passwords, and save. Refresh to rebuild the network index.

Setup imports use this container's current data location, rather than a path on the old server. Local paths from the backup must be mapped at the same container paths. If unavailable, deselect **Server settings**, import state/covers, and add locations manually. Restore network settings when possible to retain source IDs and metadata associations.

On an existing server, **Restore Data** offers the same preview and selective replacement. Uploaded covers and selected health history restore; detected folder covers and old logs are not written back to game folders or process logs. Appearance preferences apply when Server settings is selected. Source changes apply live; a changed saved-data location requires a restart. Protected shares remain offline until signed in again.

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

Restrict access through your network or proxy. Forward-auth integrations such as Authelia, Tinyauth, or Authentik can protect the app. Family Controls enforce shared action policies on the server. Optional local nickname/PIN profiles provide personal preferences and server-enforced library/game access. GameShelf does not provide SSO or an internet account service; an authenticated proxy controls who can reach the application. Setup does not replace authentication.

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

### Interface size and PIN remembrance
Advanced Appearance settings include **UI Scale** (75–150%). Dynamic resolution scaling is enabled by default: 1080p uses 100%, 1440p uses 125%, and 4K uses 150%; unknown displays use 100%. Turn dynamic scaling off to choose a manual size. The slider commits when released, with a soft transition; wheel gestures scroll instead of changing the app's scale. The preference is included in backups.

In **Family Controls**, enable PIN remembrance and choose 1–60 minutes (default 5). The unlock prompt offers an unchecked **Remember me** option. Without it, a PIN authorizes one protected action. An open Settings or configuration menu keeps a scoped approval for that menu, including saves, until it closes or 30 minutes pass. Settings and its saved Advanced view are checked together. Independent protected actions still require their own approval. Disabling remembrance hides the checkbox. Changing the PIN invalidates all existing unlocks; saving permission changes also clears grants and one-use approvals.

New servers enable all logging sources by default. Customize logging to deselect sources. Existing servers retain their saved logging choices. Retention remains unlimited by days and limited to 10 MB by default.

## Family profiles

Profiles are optional. During setup, open **Your Shelf → Family profiles → Configure**, or later use **Settings → Family Controls → Family Profiles**. You can configure profiles and roles before creating a Guardian PIN on a fresh setup. Create one through **Guardian PIN**, or let **Enable family profiles** open the PIN creator. An existing Guardian PIN still protects profile management, including resumed setup. Add the family members, then turn on **Enable family profiles**. Choose **Require PIN** when adding or editing a profile to expand its 4-digit PIN fields. Profiles without administrative permissions can open directly when this is unchecked. A profile with administrative permissions can omit its personal PIN only after an explicit save-time confirmation. Guardian PIN locks, Family Controls, and Wipe remain protected by a Guardian PIN. Existing profiles keep requiring their PIN. The toolbar profile icon switches shelves or signs out.

Profiles use square photo cards. In Add Profile or Edit Profile, click the photo square to pick one of 50 original GameShelf portraits (including 25 playful portraits for younger players), or upload a PNG, JPEG, or WebP up to 8 MB. Drag, zoom, and tilt built-in or uploaded photos to choose a square crop. Photos are stored at 256 × 256 pixels; GameShelf validates and re-encodes uploads to remove image metadata. Save the profile to apply a photo. Selecting a protected profile opens the shared **PIN Required** prompt; cancel returns to the photo cards.

Each profile keeps its own favorites and appearance choices. The browser keeps a separate Playlist for each profile. Assign all libraries or selected libraries, then all games or selected games within those libraries. Library choices become available after the locations are saved. Catalogs, statistics, cover images, individual files, and ZIP routes all enforce assignments on the server; guessing a game URL does not bypass them.

Starter roles are **Child**, **Adult**, and **Guardian**. Child keeps administration and metadata editing unavailable. Adult supports browsing and personal choices while protecting administration. Guardian grants administrative actions; its own linked Guardian PIN approves protected actions. Use the separate **Roles** and **Groups** managers to edit starter roles, create custom roles from templates, and assign shared role memberships. Group editors show the profiles and their photos together. Roles combine granted permissions, with an explicit administrative-access warning. The shared Guardian policy can add restrictions. Library access can use shared group assignments, with individual limits; game assignments remain per profile.

Profiles have no fixed count limit; saved profile data is bounded to 32 MiB. Authentication is limited to ten attempts per connected client per minute and 120 across the server. Profile cookies are HttpOnly, SameSite Strict, and Secure on direct HTTPS. Sessions expire after eight hours, signing out removes the session, and changes to profiles or roles sign everyone out. Switching profiles also clears the previous Guardian unlock. PIN verifiers use independent random salts and PBKDF2-HMAC-SHA256; no plaintext PINs are stored or logged.

**Guardian Controls** remains available on the profile picker for recovery. The Guardian PIN is separate from a person's profile PIN. Removing the last Guardian PIN offers Cancel, Create New Guardian PIN, or a confirmed removal that turns Family Profiles off while retaining saved profiles and roles. For offline owner recovery, stop the container and securely back up the data volume before changing private security records; do not expose these records publicly.

### Protected profile backups

Export Data offers **Family profiles, roles, and personal shelves** when profiles exist. This includes nicknames, profile photos, Guardian display names, salted personal PIN verifiers, roles, groups and memberships, assignments, favorites, and preferences. It requires Guardian approval when a Guardian PIN is configured. A backup passphrase is optional; when supplied for a new export, it must be at least 8 characters and include uppercase, lowercase, a number, and a symbol. Live checks turn green as each requirement is met. Generate, copy, and inline Show/Hide controls help keep a strong passphrase. Existing encrypted backups can still be restored with their original passphrase. With a passphrase, the archive contains an AES-256-GCM encrypted profile document; its key is derived using PBKDF2-HMAC-SHA256 with 600,000 iterations. Leaving it blank requires an explicit acknowledgment: the ZIP then contains unencrypted profile data, including salted personal PIN verifiers. Keep that ZIP private. The passphrase and Guardian PIN verifier are never included.

Keep the passphrase separately: it is required when restoring an encrypted profile backup, and cannot be recovered by GameShelf. A wrong passphrase or altered encrypted document is rejected before any selected data is replaced. On a fresh server, imported profiles stay disabled until you create a new Guardian PIN and explicitly enable them. On an existing protected server, the current Guardian PIN and controls remain authoritative. Restore server settings alongside profiles to preserve network source IDs and library assignments; local folder assignments require the same container paths.


### Guardian sign-in and profile management

A Guardian PIN is enough to enable Family Profiles; a dedicated Guardian profile is optional. No profile is created automatically. Select **Create a Guardian Profile** during PIN creation to opt in, or open **Manage Guardians** later. Select a Guardian PIN, then use **Associate Guardian PIN with a Profile** to link an existing profile or create a new one. Linked profiles receive the fixed Guardian role and Guardians group and use the current private Guardian PIN; changing it signs those sessions out. An existing association disables the profile-creation checkbox with an explanation. Backups preserve the association but never include the Guardian PIN verifier, so a restored server needs a new Guardian PIN.

The management screen shows profiles three across, with separate Roles and Groups managers. The sign-in picker shows up to five profiles in one horizontal row when space permits. Six or more use up to three columns and three visible rows, falling back to two columns and two rows, then one profile at a time as the available screen space and UI Scale require. Additional profiles remain scrollable. Click the first management tile to add someone. All Libraries includes current and future libraries; deselect it to choose individual libraries. Saving a profile with none selected shows a warning and leaves that person with an empty shelf. **Show GameShelf Tour on Next Sign-In** offers a tour containing only the features available to that person. Previewing a profile theme restores your own theme when you finish editing.

Turning Family Profiles off greys the controls and requires Save plus a fresh Guardian PIN. Creating the first Guardian PIN keeps the parent menu open. Changing an existing PIN clears approvals; protected actions require the new PIN.

### Game Over: erase all GameShelf data

**Advanced Settings → Data and Diagnostics → Game Over → Wipe** permanently removes GameShelf settings, credentials, Guardian PIN, profiles, roles, personal shelves, metadata, edited covers, cached catalogs, and logs. Original game folders and unrelated files are preserved. The first confirmation includes the same **Export Data** button used in Settings. Export a complete backup, including the protected profiles document, and keep its passphrase separately before continuing.

When a Guardian PIN exists, enter it once when opening Wipe. Remembered approvals cannot authorize this entry. The approval applies only to this Wipe flow and is revoked when it closes or the PIN changes. After acknowledging the backup reminder, type **Game Over** in a second confirmation. An unprotected shelf does not require creating a PIN just to Wipe. Wipe returns the server to first-time setup; it cannot be undone without a backup. Restoring encrypted profiles requires the backup passphrase; share passwords and the Guardian PIN must be set again.

### Two Guardians and personal profile information

You can create up to two different Guardian PINs in **Guardian PIN → Guardian**. Creating a PIN does not add a profile automatically: select **Create a Guardian Profile** to open the profile editor with its knight photo and Guardian link. The profile is created only when you save it. Each Guardian PIN can belong to only one profile. When a linked Guardian profile is signed in, only its own Guardian PIN approves protected actions; on a shared shelf or a non-Guardian profile, either Guardian can approve.

The three built-in roles are **Guardian**, **Adult**, and **Child**. Adult uses blue, Guardian gold, and Child green. Profiles select one role or group by default. Enable **Allow multiple Roles and Groups** to combine memberships. Multiple roles combine their granted permissions. Saving an administrative profile without a personal or linked Guardian PIN opens a separate warning with **Create PIN** and **Save Anyway**. Protected profiles do not show that warning. Groups request acknowledgment only when their selected roles grant administrative permissions. The server's Family Controls remain restrictions across every role. Existing Elevated User memberships migrate to Adult.

Use the three-dot menu on a profile's photo to edit its nickname, photo, or PIN after proving that profile's PIN. This editor cannot change roles, library assignments, visibility, or shared settings. Guardians can hide profiles and require a PIN change at next sign-in. A required PIN change must finish before a normal shelf session is issued. The exclusive **GameShelf Guardian** portrait is available first when editing a Guardian profile.

**Profile** activity is recorded by default, including sign-ins, Guardian approvals, and settings changes. You can disable this source in Customize logging or filter it in View Logs. Profile events are included when recent logs are exported; PINs and passphrases are never logged.

During first-time setup, opening Family Profiles stages the selected locations so library and game assignments are available while the main shelf stays gated. Completed setup is remembered; skipped setup stays highlighted in Settings until finished or the shelf is wiped.

### Groups, personal approvals, and Guardian migration

Create a **Group** to assign a shared role to several profiles. Choose its role and members in the group editor, or select a group when editing a profile. Selecting an administrative role opens a confirmation before it is applied. The default groups are **Guardians**, **Adults**, and **Children**, displayed in cards matching the Roles manager. Groups and memberships are included in profile backups. **Reset to Defaults** appears when a built-in role or default group differs from its defaults; group resets preserve members. Guardian permissions and membership are fixed and managed through **Manage Guardians**; their role and group editors allow renaming only. Adult defaults protect shared administration with Guardian approval.

In a group editor, set **Shared Library Access** to **No shared assignment**, **Selected libraries**, or **All libraries, including future libraries**. Then enable **Use shared group libraries** on each profile that should inherit them. Existing profiles keep their individual assignments until you opt in. Group selections combine across memberships, then the profile's individual library and game limits apply. For example, groups granting A and B with an individual limit of A allow only A. An inheriting profile with no group library grants sees no libraries. Guardian-linked profiles retain full library access.

Group library edits and membership changes require active profiles to sign in again. Resetting a default group clears its shared library assignments and preserves membership. Plain and encrypted profile backups retain group selections, inheritance choices, and individual limits. Restore server settings alongside profiles to retain network source IDs; local paths must match.

**Require PIN** accepts the current user's personal profile PIN. **Guardian PIN** is an administrative lock and requires a Guardian credential. A personal approval cannot become a Guardian approval through remembered sessions or open menus. Guardian approval can also help with an ordinary PIN action. Wipe always requires fresh Guardian approval when a Guardian PIN exists, regardless of role permissions or a personal-PIN waiver.

Guardian PIN slots have editable nicknames. In **Manage Guardians**, select the Guardian to view its linked profile, edit PIN settings, associate a profile, or remove its link. Guardian profiles remain editable from the main profile manager, while linking controls and role/group assignments are handled in Manage Guardians. **Remove Guardian Link** lets you choose a replacement role or group, starting with the current Adult role, and keeps the credential itself available. Removing a Guardian credential also confirms its replacement role and migrates its linked profile. Removing the last credential requires a separate acknowledgment that Family Profiles will turn off; Create New Guardian PIN provides a way to keep them on. Migrated profiles can receive a new personal PIN afterward.

During first-time Family Profiles setup, GameShelf explains the Guardian PIN before creating it. After the first PIN is saved, you can add a second Guardian PIN or choose No; at most two are supported. The Guardian selector appears when managing existing PINs or adding the second one.

Profile photos are optional: an empty photo uses a neutral user silhouette. The dice beside **Nickname** suggests recognizable character names matched to the profile theme; click again for another suggestion. Choosing a role template preserves its role color. Profile save errors identify a missing nickname or membership directly.
