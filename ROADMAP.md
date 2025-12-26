# GameShelf Roadmap

GameShelf is intentionally minimalist: no accounts, no databases, no external dependencies unless explicitly enabled. This roadmap outlines the planned evolution of the project while preserving its **offline-friendly, no-nonsense, LAN-focused** design. Please note that these goals are subject to change and are merely ideas. Not all features will be implemented.

---

### Core UX & Stability
* [x] *(Planned)* Responsive UI layout
* [x] *(Planned)* Web frontend embedded using `embed.FS`
* [ ] Add loading state or skeleton UI while games load
* [ ] Improve mobile spacing and responsive typography
  - Mobile view, although not entirely necessary as this application is geared towards PC libraries
  - If geared towards mobile, can consider APK file type filter or dedicated tab
* [x] *(Planned)* Manual refresh button
* [x] Integrate refresh button into GAMESHELF header text and remove button
* [ ] Add theme support (drop-in CSS files)
* [x] *(Planned)* Add micro-animations for hover and card transitions
* [ ] Add optional About/Version info box within game card
* [x] *(Planned)* Add grid/list view toggle (due to image size restrictions, list view would need to be a "without cover art" mode)
* [ ] Add a toggle UI effects option
* [ ] Add a dark/light mode toggle
* [ ] Integrate download button into card main body
* [ ] Add graceful fallback UI when `/api/games` fails
* [ ] Toggle for "Game card is download button"

### Artwork Enhancements
* [x] Ensure user-supplied artwork always overrides auto-detected art
* [x] *(Planned)* Placeholder artwork fallback
* [ ] *(Planned)* Add optional external artwork fetching (IGDB / RAWG / SteamGridDB)
  - Env to include, optional 
* [ ] Cache fetched artwork locally
  - If cached, skip fetch
* [ ] Add ability to directly upload cover image from UI (security risks with write access, current scope does not allow file management on purpose)

### Metadata & Sorting
* [ ] Parse `.json`, `.info`, or GOG manifest metadata offline
* [x] *(Planned)* Add sorting options (name, size, date added)
* [ ] Add client-side filtering (genre, developer, year)
* [ ] Add “Recently Added” section
* [x] Add functional search bar
* [ ] Add a dice icon and randomize logic from parsed folder names to suggest a game download
* [ ] Add ability to group games together by adding tags (requires lightweight database integration)
* [ ] Reintroduce "no games found" subheader directing users where to store/add games
    * [ ] Create a second error message and link it to search when no games are found
* [ ] Reintroduce "x" to clear search bar (revisit browser defaults, possibly add custom svg for clear)

### Downloads & File Handling
* [x] *(Planned)* ZIP download streaming
* [x] *(Planned)* Display file size calculation on game card
* [x] *(Planned)* Folder autodiscovery
* [ ] Add multi-select mode for downloading multiple folders ("bulk download" option)
* [ ] Add optional GOG API integration for automatic downloads (account-based, but reduces the need for manual transfers)
 - Env to include, optional 
* [ ] Add support for multiple directories

### Administration, Security & LAN
* [ ] Add local-only analytics (downloads, refresh history, recent activity)
* [ ] Add `/api/stats` for UI integrations

### Docker / GHCR
* [ ] Add multi-arch builds (amd64 + arm64)
* [x] *(Planned)* Environment variable configuration
* [x] Add a responsible distribution use/disclaimer statement tp README
* [ ] Additional logging outputs
> [!NOTE]
> For substantial features that are beyond the minimal design approach, separate versions should be created (eg. "gameshelf:plus-gog", "gameshelf:plus-auto-search", etc.)