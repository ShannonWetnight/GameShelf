# GameShelf [![GitHub release](https://img.shields.io/github/v/release/shannonwetnight/gameshelf.svg?style=flat-square)](https://github.com/shannonwetnight/gameshelf/releases/latest) [![GHCR](https://img.shields.io/badge/GHCR-gameshelf-blue?logo=github)](https://github.com/users/shannonwetnight/packages/container/package/gameshelf) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
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
    + [Environment Variables](#environment-variables)
- [Optional Installation Steps](#optional-installation-steps)
    + [Reverse Proxy](#reverse-proxy)
        + [Traefik Example](#traefik-example)
    + [Single Sign-On](#single-sign-on)
    + [Cover Art](#cover-art)
        + [Recommended Resolution](#recommended-resolution)
        + [How GameShelf Chooses an Image](#how-gameshelf-chooses-an-image)
- [Usage](#usage)

## Overview
GameShelf is a lightweight, no-nonsense, completely open-source game library designed for offline DRM-free storage collections.  
Point it at a directory and GameShelf automatically:
- Indexes game folders
- Detects and displays cover art, such as `cover.jpg`, `folder.png`, etc.
- Generates downloadable ZIP archives on demand
- Serves a clean, modern UI over your local network

### Project Philosophy
GameShelf is designed to provide a straightforward, dependable, read-only LAN-based game library with minimal overhead. It avoids unnecessary dependencies and account systems, allowing you to maintain complete control over your offline collections. The major intended use case for GameShelf is to provide easy access to DRM-free game installers to a small number of local users (eg. 1-10 users in the same house) without the need for 1st/3rd-party installers and account logins. There are no databases, logins, analytics, or external dependencies unless you choose to enable optional cover-fetching (see [roadmap](https://github.com/ShannonWetnight/gameshelf/blob/main/ROADMAP.md#artwork-enhancements)). Drop your games into a folder, run GameShelf, and enjoy a clean local library.

## Features
- Automatic folder indexing
- Local cover art detection
- Instant ZIP downloads of game folders
- Manual and scheduled rescan support
- Zero-config outside of the indexing directory
- Go backend and static web UI
- Easy deployment with Docker or Compose

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
      # Optional: v
      #- GAMESHELF_ADDR=:8080
      # Optional: Set a refresh interval to override library refresh (default unless uncommented: 0) | Options: 1m 1h (replace "1" with desired variable, or "0" without a time denomination to disable auto-refresh)
      #- GAMESHELF_REFRESH_INTERVAL= 12h
    volumes:
      - /path/to/games:/games:ro
    security_opt:
      - no-new-privileges:true
```

### Environment Variables
| Variable                     | Default  | Description                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------------- |
| `GAMESHELF_ROOT`             | `/games` | Directory containing indexable folders.                                         |
| `GAMESHELF_ADDR`             | `:8080`  | Optional: Change GameShelf's default (`8080`) internal bind address.                                           |
| `GAMESHELF_REFRESH_INTERVAL` | `0`    | Optional: auto-scan interval (`1d`, `1h`,`1m`, `1s`, - `0` disables auto-refresh) |

**After successful installation, navigate to GameShelf's `IP:8080` address to view the indexed content.**

## Optional Installation Steps

### Reverse Proxy
For ease of use, it is recommended to use a reverse proxy for accessing GameShelf, such as `games.mydomain.com`. Use the service of your choice to accomplish this. The below configuration is a working example from [Traefik](https://doc.traefik.io/traefik/).

#### Traefik Example
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
```

```yaml
services:

    gameshelf:
      loadBalancer:
        servers:
          - url: "http://gameshelf:8086"
        passHostHeader: true
```

```yaml
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

### Single Sign-On
You can easily lock GameShelf behind SSO with Authelia, Tinyauth, Authentik, and more, by using forward Auth.
> [!NOTE]
> GameShelf was not created to natively support SSO, user creation, mapping, or profiles. The purpose of GameShelf is to offer a frictionless library of DRM-free games to a local network, typically between 1-10 users in size. Using SSO or branching and adding profile functionality can be done but extends beyond the scope of GameShelf's intended purpose.

### Cover Art
GameShelf supports custom cover images for any game folder. To add your own artwork, place a cover image in the game’s directory using one of the supported file types:
- `cover.jpg`
- `cover.jpeg`
- `cover.png`
- `cover.webp`
> [!IMPORTANT]
> Only the above filenames and extensions are recognized. The file must be located directly inside the game’s root folder (eg. `Star Wars Jedi Knight II - Jedi Outcast > cover.png`), not in subdirectories.

#### Recommended Resolution
High-quality artwork is recommended. A resolution around 600×900 (3:4) works well; however, GameShelf automatically crops and scales the artwork into a portrait format and ratio of 2:3, so the final appearance will be vertically oriented regardless of the original aspect ratio.
- File size may be a performance factor to consider for libraries that include many games.

#### How GameShelf Chooses an Image
When loading a game entry:
1. GameShelf checks for cover.jpg, then cover.jpeg, cover.png, and finally cover.webp.
2. The first matching file found is used as the game’s cover art.
3. If no cover image is provided, GameShelf will fall back to:
4. `planned feature` Attempting automatic artwork retrieval (if enabled), or
5. `current behavior` Displaying the placeholder.png cover if nothing is available.
This allows users to fully override auto-fetched artwork simply by placing their own cover.* image into the game’s folder.

## Usage
1. Upload folders to the GameShelf directory (your mounted storage).
2. View and/or download zipped folders from the web UI.

## Roadmap
View the [roadmap](https://github.com/ShannonWetnight/gameshelf/blob/main/ROADMAP.md) for a list of features worth considering for GameShelf.
