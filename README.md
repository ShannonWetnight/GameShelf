# GameShelf [![GitHub release](https://img.shields.io/github/v/release/shannonwetnight/gameshelf.svg?style=flat-square)](https://github.com/shannonwetnight/gameshelf/releases/latest) [![GHCR](https://img.shields.io/badge/GHCR-gameshelf-blue?logo=github)](https://github.com/users/shannonwetnight/packages/container/package/gameshelf) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![GameShelf Showcase](https://raw.githubusercontent.com/shannonwetnight/gameshelf/main/images/gameshelf_showcase.gif)

> **AI Workflow Notice**  
> Parts of GameShelf are developed with the assistance of AI tools to accelerate boilerplate generation, UI layout, and documentation drafting. All logic, architecture decisions, and final code have been reviewed and curated by the project maintainers. GameShelf is fully open-source (MIT licensed), and all contributors are welcome.

## Table of Contents
- [Overview](#overview)
    + [Project Philosophy](#project-philosophy)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
    + [Docker Run](#docker-run)
    + [Docker Compose](#docker-compose)
    + [Container User and File Permissions](#container-user-and-file-permissions)
    + [Environment Variables](#environment-variables)
- [Optional Installation Steps](#optional-installation-steps)
    + [Reverse Proxy](#reverse-proxy)
        + [Traefik Example](#traefik-example)
    + [Single Sign-On](#single-sign-on)
    + [Cover Art](#cover-art)
        + [Recommended Resolution](#recommended-resolution)
        + [How GameShelf Chooses an Image](#how-gameshelf-chooses-an-image)
    + [Recommended File Structure](#recommended-file-structure)
- [Usage](#usage)
- [Roadmap](#roadmap)
- [Testing and releases](#testing-and-releases)
- [Legal Disclaimer](#responsible-use--distribution)

## Overview
GameShelf is a lightweight, no-nonsense, completely open-source game library designed for offline DRM-free storage collections. Point it at a directory and GameShelf automatically:
- Indexes game folders
- Detects and displays cover art, such as `cover.jpg`, `folder.png`, etc.
- Serves a clean, modern UI over your local network
- Provides one-click downloadable ZIP archives on demand

### Project Philosophy
GameShelf is designed to provide a straightforward, dependable, read-only LAN-based game library with minimal overhead. It avoids unnecessary dependencies and account systems, allowing you to maintain complete control over your offline collections. The major intended use case for GameShelf is to provide easy access to DRM-free game installers to a small number of local users (eg. 1-10 users in the same house) without the need for 1st/3rd-party installers and account logins. Simply drop your games into a folder, run GameShelf, and enjoy a clean local library.

## Features
- Automatic folder indexing
- Local cover art detection
  - User-supplied cover art and placeholders while missing
- Instant ZIP downloads of game folders
- An optional download Playlist that combines up to 50 chosen games in one ZIP, with a review step and estimated size
- Manual and scheduled rescan support
- Zero-config outside of the indexing directory
- Go backend and static web UI (Go 1.24 or later for source builds)
- Easy deployment with Docker or Compose
- Local fuzzy search and sorting by name or size, plus Favorites and Recently Added filters
  - Search keyboard shortcuts (`/` to search, `Esc` to clear)
- Grid and list views with optional list thumbnails, a random game picker, and card details with individual file downloads
- System, GameShelf Classic, Light, Dark, and Retro Arcade themes; optional game title banners, placeholder art, button hints, card stars, and slower picker animations in Settings
- Basic and Advanced settings, optional tile fill on refresh, and a switch to disable all animations
- Editable GameShelf titles and cover art from uploads or supported images already in a game folder, with crop, rotation, and tilt controls
- Saved favorites with an on-by-default favorites-first setting, configurable Recently Added range, selective metadata reset, and success notifications for downloads and changes
- Selective library backup export of state, server settings, logs, and available covers
- Preview and restore exported library state, uploaded covers, and compatible server settings from Settings
- Three-column desktop Settings layout and an always-available application log viewer with type filters, copy, and download controls
- Configurable system, library, error, request, scan, and download logging, with optional size and age retention limits
- Multiple local or host-mounted library sources under the configured library mount
- Read-only `/api/stats` summary for local integrations

## Prerequisites
- [Docker](https://docs.docker.com/engine/install/) or
- [Docker Compose](https://docs.docker.com/compose/install/)
- A mountable directory for GameShelf to index
- 10-15 minutes of free time

## Quick Start

### Docker Run
```bash
docker run -d \
  --name gameshelf \
  --restart unless-stopped \
  --security-opt no-new-privileges:true \
  -p 8080:8080 \
  -e GAMESHELF_ROOT=/games \
  -v /path/to/your/library:/games:ro \
  ghcr.io/shannonwetnight/gameshelf:latest
```
### Docker Compose

```yaml
---
services:
  gameshelf:
    image: ghcr.io/shannonwetnight/gameshelf:latest
    container_name: gameshelf
    restart: unless-stopped
    ports:
      - 8080:8080 # Increment if in-use
    environment:
      # Directory containing indexable folders. 
      - GAMESHELF_ROOT=/games
      # Optional: change the internal bind address (default :8080)
      #- GAMESHELF_ADDR=:8080
    volumes:
      - /path/to/games:/games:ro
      - gameshelf-data:/data
    security_opt:
      - no-new-privileges:true

volumes:
  gameshelf-data:
```

### Container User and File Permissions

The Docker image runs as the unprivileged user `gameshelf`, UID `10001` and GID `10001`. The executable stays owned by root. GameShelf reads the collection and streams ZIPs directly to the client. It writes first-seen dates to a small JSON file in `/data`; the game library remains read-only. Docker creates storage for `/data` automatically, so the Docker Run example needs no second mount. The Compose example uses a Docker-managed named volume, created automatically by Compose, so dates also survive removing and recreating the stack. No extra host directory or separate database service is needed. The image does not change ownership or permissions on your library.

Game IDs keep the existing slug for ordinary folders. When names normalize to the same slug, GameShelf assigns distinct IDs using SHA-256 suffixes derived from the exact folder names. Existing colliding libraries keep the old slug attached to the folder that previously occupied it. Assignments are saved in `/data/library-state.json` and retained for absent folders, keeping links stable across rescans, restarts, and adding or removing colliding folders. Customized titles, favorites, first-seen dates, and uploaded artwork stay associated with their folders. If `/data` cannot be written, browsing still works: new assignments remain in memory and the next scan retries saving them. Keep `/data/library-state.json` to preserve saved identities across restarts. Renaming a folder creates a new folder identity, as it does for existing metadata.

If your own Compose or Portainer stack has no `/data` volume entry, Docker uses an anonymous volume. It normally survives container restarts, but a newly created container after a stack removal may not reconnect to that volume. For reliable redeploys, add `gameshelf-data:/data` to the service and declare `gameshelf-data:` under the top-level `volumes:` section, as in the example above.

In Settings, **Export Data** opens a selection dialog for `library-state.json`, server settings, recent application logs, and each available game cover. The resulting `gameshelf-library-backup.zip` can contain first-seen dates, customized titles, favorites, uploaded cover art, and cover images found in game folders. Uploaded covers are stored under `covers/<game>/`; folder covers are stored under `folder-covers/<game>/` with their original filenames. Placeholder images are excluded. The log item contains the retained messages from the current process (10 MB and 7 days by default). The server finishes the ZIP in a private temporary file in `/data` before starting the download; allow free space there for the archive. Temporary files are removed after the request finishes. Exports require write access to `/data`; deployments that override the container user must provide a state volume writable by that identity. If metadata or an indexed cover cannot be read, or the archive cannot be completed, Settings shows an export failure and offers no ZIP. Retry after correcting the problem shown in the container logs.

**Settings → Application Logs → View Logs** opens the current process's bounded log snapshot. The viewer starts at the newest entries and can filter system, library, error, request, scan, and download entries. Its header controls copy the visible lines or download them as `gameshelf-logs.txt`. **Configure** offers Customize logging: without it, system, library, and error events stay on; with it, each category can be selected independently. Logs remain in memory for this process only. The default retention is 7 days and 10 MB; either limit can be overridden in Configure.

The toolbar Playlist button opens a review of selected games and their estimated uncompressed size. Add or remove games from cards, the details panel, or the random game view, then download one `gameshelf-playlist.zip`. Each game is placed in its own folder inside the archive. The Playlist holds up to 50 games and remains on this browser until cleared; the ZIP is streamed on demand. Removing a game or clearing the Playlist asks for confirmation. The entire Playlist can be hidden in Settings.

The cover editor can select PNG, JPEG, GIF, or WebP images already inside a game's folder. The selected image opens in the editor for adjustments; saving creates a PNG in application data. Game folders remain read-only.

**Advanced Settings → Library Sources** accepts one container path per line, up to 16 sources. The first path is the primary source; existing game links keep their IDs. Additional sources and duplicate folder names receive separate stable IDs and cover storage. Secondary sources may be mounted beneath the primary path, but must not overlap one another. A directory containing a configured secondary source is treated as a mount container, not a game. Paths must be present within the original library mount. For a NAS, mount its SMB, NFS, SSHFS, WebDAV, or other supported share on the Docker host and bind it read-only beneath `/games`, then add that container path in Library Sources. Network addresses and credentials are configured with the host's mount tools; GameShelf does not currently connect to a share URL or store share passwords. Source changes take effect after a container restart. Automatic scan timing is configured separately under **Advanced Settings → Refresh Interval** in whole hours; the default is 168 hours (one week) unless an existing deployment supplies a different value. Enter 0 to disable automatic scans.

Keep this ZIP with your other backups. To restore it, open **Settings → Restore Data**, choose the exported ZIP, and review its contents. Select library state, uploaded covers, and/or server settings, acknowledge that those selected files will be replaced, then confirm. Game-folder cover copies and logs in the archive are not restored; mounted game folders remain read-only. The ZIP is validated before changes are made, and selected files are staged before replacement. Archives are limited to 64 MiB compressed, 128 MiB expanded, and 500 entries. Server paths in a backup must be valid in the current container before restoring settings; deselect settings if they refer to another deployment. Restoring settings may require a container restart. The game library still needs to be mounted at the same container path for saved dates, favorites, and customized titles to match.

“Date added” means the first successful scan after this feature is enabled, not the folder's filesystem creation date. Games already in the library receive that initial scan date. Removing a game and refreshing removes its stored date; adding it again starts a new date. If `/data` cannot be written, the library still loads and new dates stay blank until storage is fixed. The `/api/games` response includes `idPersisted`: `true` means the current ID is present in saved state or was successfully saved by this scan; `false` means the identity is temporary. Logs report temporary assignments. During one process lifetime, GameShelf retains assignments for absent folders too, preventing their URLs from changing owners during rescans. After a restart without saved assignments, the same folder set produces the same IDs, but adding, removing, or renaming colliding folders can change temporary URLs. If saved state becomes readable again, its assignments take priority over temporary ones, so conflicting temporary URLs can change at recovery. Unreadable or invalid state is never overwritten; restore or repair it to recover saved identities, then rescan. A successful scan with writable storage saves temporary assignments for future restarts.

When upgrading from an older image that ran as root, check access before recreating the container. The runtime identity needs read and search (execute) permission on the mounted collection and every game subdirectory, plus read permission on every game file and cover image. A read-only mount prevents writes but does not grant read access. An inaccessible collection root prevents startup; inaccessible files or subdirectories can cause scan warnings, failed covers, or incomplete ZIP downloads. Check container logs if content is missing.

Publicly readable collections (directories `0755`, files `0644`) work with the default identity. For a private collection, use its existing non-root owner or a group/ACL that grants read and directory search access. Keep these permissions limited to the intended collection; `chmod 777` is unnecessary.

To run as an existing host identity, add `--user 1000:1000` to `docker run`, or set this in the Compose service (replace the example IDs with yours):

```yaml
    user: "1000:1000"
```

For group-only access, add `--group-add 2000` to `docker run`, or use:

```yaml
    group_add:
      - "2000"
```

These are numeric Docker settings; the image does not interpret `PUID` or `PGID` environment variables. An arbitrary non-root UID/GID works without a matching account inside the image, provided it can read the library and write to `/data`. Rootless Docker, user namespace remapping, NAS ACLs, and SELinux labeling can affect host access; match permissions to the identity and mount policy used by your deployment.

Keep the collection mount read-only and retain `no-new-privileges:true`. You can also add `--read-only --cap-drop=ALL` to `docker run`, or the following Compose settings; the image's `/data` volume remains writable:

```yaml
    read_only: true
    cap_drop:
      - ALL
```

Use an internal port above `1023` with `GAMESHELF_ADDR` for portable unprivileged operation. To expose host port 80, map `80:8080` while keeping the internal listener on `8080`. `GAMESHELF_ROOT`, `GAMESHELF_DATA_DIR`, and `GAMESHELF_ADDR` continue to work with the non-root user. Configure automatic scans in Advanced Settings; older `GAMESHELF_REFRESH_INTERVAL` values are still read as an initial setting for compatibility.

### Environment Variables
| Variable                     | Default  | Description                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------------- |
| `GAMESHELF_ROOT`             | `/games` | Directory containing indexable folders.                                         |
| `GAMESHELF_DATA_DIR`         | `/data`  | Writable app state for first-seen dates; the image provides Docker-managed storage at this path. |
| `GAMESHELF_ADDR`             | `:8080`  | Optional: Change GameShelf's default (`8080`) internal bind address.                                           |

**After successful installation, navigate to GameShelf's `IP:8080` address to view the indexed content.**

## Optional Installation Steps

### Reverse Proxy
For ease of use, it is recommended to use a reverse proxy for accessing GameShelf, such as `games.mydomain.com`. Use the service of your choice to accomplish this. The below configuration is a working example from [Traefik](https://doc.traefik.io/traefik/).

#### Traefik Example

Use this dynamic configuration with Traefik's file provider and an existing `https` entry point. Traefik and GameShelf must share a Docker network where `gameshelf` resolves to the GameShelf container. The backend URL uses GameShelf's default internal port, `8080`.

```yaml
http:
  routers:

    gameshelf:
      entryPoints:
        - "https"
      rule: "Host(`games.mydomain.com`)"
      middlewares:
        - default-chain
      tls: {}
      service: gameshelf

  services:

    gameshelf:
      loadBalancer:
        servers:
          - url: "http://gameshelf:8080"
        passHostHeader: true

  middlewares:

    https-redirectscheme:
      redirectScheme:
        scheme: https
        permanent: true

    default-headers:
      headers:
        frameDeny: true
        browserXssFilter: true
        contentTypeNosniff: true
        forceSTSHeader: true
        stsIncludeSubdomains: true
        stsPreload: true
        stsSeconds: 15552000
        customFrameOptionsValue: SAMEORIGIN
        customRequestHeaders:
          X-Forwarded-Proto: https

    default-chain:
      chain:
        middlewares:
        - https-redirectscheme
        - default-headers
```

Traefik connects directly to the container port on the shared network. Changing only the published host port (for example, `8086:8080`) leaves the backend URL at `http://gameshelf:8080`.

To use a custom internal port, set `GAMESHELF_ADDR=:8086` in GameShelf's environment and change the Traefik backend URL to `http://gameshelf:8086`. If you also publish a host port, update the container side of that mapping to match (for example, `8086:8086`).

### Single Sign-On
You can easily lock GameShelf behind SSO with Authelia, Tinyauth, Authentik, and more, by using forward Auth.
> [!NOTE]
> GameShelf was not created to natively support SSO, user creation, mapping, or profiles. The purpose of GameShelf is to offer a frictionless library of DRM-free games to a local network, typically between 1-10 users in size. Using SSO or branching and adding profile functionality can be done but extends beyond the scope of GameShelf's intended purpose as a frictionless local file distributor.

### Cover Art
For any game, open its information panel and select **Add cover** or **Edit cover**. Choose an image, rotate or tilt it, then drag and zoom it to crop the preview. Save to use the resulting cover. GameShelf stores the edited PNG in its writable `/data` storage, leaving the game folder read-only. Uploaded covers take priority over images found in game folders and are included in **Export data**. Anyone who can access the GameShelf interface can change covers; use your existing network access controls or reverse proxy if this should be restricted.

Alternatively, place a cover image in the game’s directory using one of the supported file types:
- `cover.jpg`
- `cover.jpeg`
- `cover.png`
- `folder.jpg`
- `folder.jpeg`
- `folder.png`
> [!IMPORTANT]
> Only the above filenames and extensions are recognized. The file must be located directly inside the game’s root folder (eg. `Star Wars Jedi Knight II - Jedi Outcast > cover.png`), not in subdirectories.
>
> If no cover art is available, GameShelf uses its default fallback image (`placeholder.png`) until you upload one or add one to the game folder and refresh. [Moby Games](https://www.mobygames.com/) and [GameTDB](https://www.gametdb.com/) are two places to find cover art for your games.

#### Recommended Resolution
High-quality artwork is recommended. A resolution around 600×900 (2:3) works well; the editor creates a 600×900 PNG.
- File size may be a performance factor to consider for libraries that include many games. Consider compressing your high-quality cover art before adding to the root of your game folders to reduce overall cover art file size.

#### How GameShelf Chooses an Image
When loading a game entry:
1. GameShelf uses an uploaded cover from `/data` when one exists.
2. Otherwise it checks for `cover.jpg`, `cover.jpeg`, `cover.png`, `folder.jpg`, `folder.jpeg`, and `folder.png` in the game folder.
3. If no cover image is provided, GameShelf displays its placeholder.

### Recommended File Structure
As GameShelf parses folder names from `GAMESHELF_ROOT`, it is important to properly structure your master games directory. The following folder structure is recommended to keep things simple for GameShelf:
```
GameDrive
  Games
    Game Example 1
      Installation Files
      cover.png
    
    Game Example 2
      Installation Files
      cover.png

    Game Example 3
      Installation Files
      Extras
        Patch 1
        Patch 2
      cover.png
    
    Game Example 4
      Installation Files
      Manuals
        game_example_4_manual.pdf
      cover.png
```
## Usage
1. Upload folders to the GameShelf directory (your mounted storage).
2. Open GameShelf to search or sort the library, switch between grid and list views, or use the dice button to pick a random game. **All** clears the active sort/filter. Favorites and Recently Added are available in the sort/filter menu; Settings controls the Recently Added range and whether favorite stars appear on cards. Card stars are off by default; when enabled, the default suboption shows them only on favorited cards. The GameShelf icon returns to the unfiltered grid; the GameShelf text refreshes the library. Return to the library or reroll from the selected card.
3. Hover over a game card or list row for its download and information controls. Download retrieves that game's folder as a ZIP and shows a brief download-started notification. The information panel shows its title, location, size, cover status, date added, and file count; on desktop, the cover panel also offers a full-game download. Open the file count to download individual files directly. List cover thumbnails are on by default and can be hidden in Settings.
4. Edit a GameShelf title or upload and adjust cover art from the information panel. The file count below **Download Game** opens a separate file list with individual downloads. **Reset Metadata** can restore the folder title, folder cover (or placeholder), and unfavorited state after review and confirmation. The original first-seen date is preserved. These changes live in `/data`; they do not modify your mounted game folders. Settings includes an export of saved titles, dates, and real cover images.

Settings also offers appearance themes (**System**, **GameShelf Classic**, **Light**, **Dark**, and **Retro Arcade**), card and list display preferences, **Library Sources**, **Refresh Interval**, and **Application Logs**. The compact Basic/Advanced switch reveals source, refresh, animation, Recently Added range, and list-image expansion controls. System follows the device's light or dark preference; a dark system uses GameShelf Classic. The refresh interval is configured in whole hours, defaults to 168 hours, and accepts 0 to disable automatic scans. Saved path and interval changes take effect after a container restart; log configuration changes take effect immediately. Paths must already exist inside the container and remain within the library and data mounts originally configured by Docker. Changing the data path does not move saved metadata or artwork, so copy them to the new location before restarting. Advanced Settings includes a confirmed **Reset All Settings** action that restores preferences and server settings without deleting game metadata or covers; restart the container if paths or refresh timing changed. Settings are kept in `server-settings.json` under the original data mount, and can be included in Export Data. Saves and exports show a temporary confirmation banner; errors remain visible where the action was started.

For local dashboards, `GET /api/stats` returns JSON fields `gameCount`, `fileCount`, `totalSizeBytes`, `coveredGameCount`, and `lastIndexedAt` (UTC RFC 3339). Counts reflect the current indexed game state: library file counts and sizes update on a successful scan, while cover availability also updates after an upload. `fileCount` and `totalSizeBytes` include regular files in indexed game folders, including folder cover files; uploaded covers in `/data` are not counted. `lastIndexedAt` marks the last successful scan and is empty until one succeeds. This endpoint does not expose host filesystem paths.

## Roadmap
View the [roadmap](ROADMAP.md) for a list of features worth considering for GameShelf.

## Testing and releases

This branch contains the development tests and package tooling. Use **Edge tests and prerelease** in Actions for test packages and optional prereleases. Promote reviewed application changes and release notes to main individually; keep the test harness on Edge. See the [release guide](.github/RELEASING.md).

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


### Default preferences

New browsers use the System theme, animated loaded tiles, button hints, placeholder images, favorites first, list images, Playlist downloads, and single-click list image expansion. Slow motion, disabled animations, and game titles start off; favorited game stars stay pinned on cards by default. Recently Added uses 7 days and automatic refresh uses 168 hours. Backup options start selected. Existing saved preferences are preserved. **Reset All Settings → Wipe** restores defaults after confirmation.

The Advanced **Click to expand image in list view** preference offers **Single-click** (default), **Double-click**, and **Disabled**. Image expansion requires list images to be enabled. Menus use matching opening and closing motion, respecting disabled animations and reduced-motion preferences.

**Show favorited game stars on top** keeps stars visible for favorite games. Turn it off to show stars with the other card controls on hover. Icon buttons highlight their symbols on hover while keeping their original click areas; save controls retain their confirmation styling.

## Appearance themes

Choose a theme in **Settings → Appearance**. System, GameShelf Classic, Light, Dark, and Retro Arcade remain available. Additional themes are:

| Theme | Palette and effects |
| --- | --- |
| Neon Mirage | Cyan and pink arcade glow, a perspective grid, and a moving CRT wash; warm ivory text. |
| Cartridge Gray | Classic console grays, ivory surfaces, and red accents. |
| Deep Space | Deep blue nebulae, drifting and twinkling stars, and starry card overlays. |
| Ion Grid | A teal science-fiction interface with a quiet technical grid and scanning card overlays. |
| Rose Quartz | Pink and pearl colors with glitter that follows the pointer over covers. |
| Midnight | Black surfaces and a soft pointer flashlight that reveals the cover through its dark blur. |
| Lattice | A green-and-ivory geometric theme with moving threads of light around the pointer. |

Expressive themes recolor the GameShelf logo to match. Standard Classic, Light, and Dark keep the existing branding. **Disable all animations** and the device's reduced-motion preference stop ambient motion. Settings that save immediately display a confirmation banner; configuration dialogs confirm after their save icon is pressed.
