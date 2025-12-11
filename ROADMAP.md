# GameShelf Roadmap

GameShelf is intentionally minimalist: no accounts, no databases, no external dependencies unless explicitly enabled. This roadmap outlines the planned evolution of the project while preserving its **offline-friendly, no-nonsense, LAN-focused** design. Please note that these goals are subject to change and are merely ideas. Not all features will be implemented.

---

### Core UX & Stability
* [x] Responsive UI layout
* [x] Web frontend embedded using `embed.FS`
* [ ] Add loading state or skeleton UI while games load
* [ ] Improve mobile spacing and responsive typography
* [ ] Add micro-animations for hover and card transitions
* [ ] Add optional About/Version info box within game card
* [ ] Add visible UI feedback during refresh (spinner or toast)
* [ ] Display “Last refreshed at…” timestamp
* [ ] Add graceful fallback UI when `/api/games` fails

### Artwork Enhancements
* [x] Placeholder artwork fallback
* [ ] Add slight blur to placeholder backgrounds
* [ ] Ensure user-supplied artwork always overrides auto-detected art
* [ ] Add optional external artwork fetching (IGDB / RAWG / SteamGridDB)
* [ ] Cache fetched artwork locally

### Metadata & Sorting
* [x] Manual refresh button
* [ ] Parse `.json`, `.info`, or GOG manifest metadata offline
* [ ] Add sorting options (name, size, date added)
* [ ] Add client-side filtering (genre, developer, year)
* [ ] Add “Recently Added” section

### Downloads & File Handling
* [x] ZIP download streaming
* [x] Display file size calculation on game card
* [x] Folder autodiscovery
* [ ] Add multi-select mode for downloading multiple folders

## 4. Administration, Security & LAN Features
* [ ] Add local-only analytics (downloads, refresh history, recent activity)
* [ ] Store analytics in local JSON (never external)
* [ ] Add `/api/stats` for UI integrations

### Docker / GHCR
* [ ] Add multi-arch builds (amd64 + arm64)
* [x] Environment variable configuration

### Stretch Features
* [ ] Add theme support (drop-in CSS files)
* [ ] Add grid/list view toggle
