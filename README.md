# GameShelf v1.0

> **AI Workflow Notice**  
> Parts of GameShelf are developed with the assistance of AI tools to accelerate boilerplate generation, UI layout, and documentation drafting. All logic, architecture decisions, and final code have been reviewed and curated by the project maintainers. GameShelf is fully open-source (MIT licensed), and all contributors are welcome.

## Table of Contents
- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
    + [Docker Run](#docker-run)
    + [Docker Compose](#docker-compose)
- [Optional Installation Steps](#optional-installation-steps)
    + [Reverse Proxy](#reverse-proxy)
      + [Traefik](#traefik)
    + [Single Sign-On](#single-sign-on)
- [Usage](#usage)

## Overview
GameShelf is a lightweight, no-nonsense LAN game library designed for offline storage collections.  
Point it at a directory and GameShelf automatically:
- Indexes game folders  
- Detects and displays cover art (`cover.jpg`, `folder.png`, etc.)
- Generates downloadable ZIP archives on demand
- Serves a clean, modern UI over your local network

There are no databases, logins, analytics, or external dependencies unless you choose to enable optional cover-fetching (see roadmap). Drop your games into a folder, run GameShelf, and enjoy a clean local library.

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
- 10-15 minutes of free-time

## Quick Start

### Docker Run
```bash
docker run -d \
  --name gameshelf \
  -p 8080:8080 \
  -e GAMESHELF_ROOT=/games \
  -v /path/to/your/library:/games \
  ghcr.io/ShannonWetnight/gameshelf:latest
```
### Docker Compose

```yaml
---
services:
  gameshelf:
    image: ghcr.io/ShannonWetnight/gameshelf:latest
    container_name: gameshelf
    restart: unless-stopped
    ports:
      - 8080:8080 # Increment if in-use
    environment:
      # Working directory for indexing folders
      - GAMESHELF_ROOT=/games
      # GameShelf port
      - GAMESHELF_ADDR=:8080
      # Optional: Set a refresh interval to override library refresh (default unless uncommented: 12h) | Options: 1m 1h (replace "1" with desired variable)
      # - GAMESHELF_REFRESH_INTERVAL= 5m
    volumes:
      - /path/to/games:/games:ro
    security_opt:
      - no-new-privileges:true
```
After successful installation, navigate to GameShelf's `IP:8080` to view the indexed content.

## Optional Installation Steps

### Reverse Proxy
For ease of use, it is recommended to use a reverse proxy for accessing GameShelf, such as `games.mydomain.com`. Use the service of your choice to accomplish this. The below configuration is a working example from [Traefik](https://doc.traefik.io/traefik/).

#### Traefik
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
> GameShelf was not created to natively support SSO, user creation, mapping, or profiles. The purpose of GameShelf is to offer a frictionless library of DRM-free games to a local network, typically between 1-10 users in size. Using SSO or branching and adding profile functionality can be done but extends beyond the scope of GameShelf's intended purpose.

## Usage
1. Upload folders to the GameShelf directory (your mounted storage).
2. View and/or download zipped folders from the web UI.
