# GameShelf Roadmap

GameShelf is intentionally minimalist: no accounts, no databases, no external dependencies unless explicitly enabled. This roadmap outlines the planned evolution of the project while preserving its **offline-friendly, no-nonsense, LAN-focused** design. Please note that these goals are subject to change and are merely ideas. Not all features will be implemented.

---

### Core UX & Stability
* [x] *(Planned)* Responsive UI layout
* [x] *(Planned)* Web frontend embedded using `embed.FS`
* [ ] Add loading state or skeleton UI while games load
* [ ] *(Planned)* Improve mobile spacing and responsive typography
* [ ] Add theme support (drop-in CSS files)
* [ ] *(Planned)* Add micro-animations for hover and card transitions
* [ ] Add optional About/Version info box within game card
* [ ] *(Planned)* Add grid/list view toggle
* [ ] *(Planned)* Add visible UI feedback during refresh (spinner or toast)
* [ ] *(Planned)* Display “Last refreshed at…” timestamp
* [ ] Add graceful fallback UI when `/api/games` fails

### Artwork Enhancements
* [x] *(Planned)* Placeholder artwork fallback
* [ ] Add slight blur to placeholder backgrounds
* [ ] Ensure user-supplied artwork always overrides auto-detected art
* [ ] *(Planned)* Add optional external artwork fetching (IGDB / RAWG / SteamGridDB)
* [ ] Cache fetched artwork locally

### Metadata & Sorting
* [x] *(Planned)* Manual refresh button
* [ ] Integrate refresh button into GAMESHELF header text and remove button
* [ ] Parse `.json`, `.info`, or GOG manifest metadata offline
* [ ] *(Planned)* Add sorting options (name, size, date added)
* [ ] Add client-side filtering (genre, developer, year)
* [ ] Add “Recently Added” section

### Downloads & File Handling
* [x] *(Planned)* ZIP download streaming
* [x] *(Planned)* Display file size calculation on game card
* [x] *(Planned)* Folder autodiscovery
* [ ] Add multi-select mode for downloading multiple folders
* [ ] Add optional GOG API integration for automatic downloads (account-based, but reduces the need for manual transfers)

### Administration, Security & LAN
* [ ] Add local-only analytics (downloads, refresh history, recent activity)
* [ ] Add `/api/stats` for UI integrations

### Docker / GHCR
* [ ] Add multi-arch builds (amd64 + arm64)
* [x] *(Planned)* Environment variable configuration
