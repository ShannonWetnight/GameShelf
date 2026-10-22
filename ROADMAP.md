# GameShelf Roadmap

GameShelf is intentionally minimalist: no accounts, no databases, no external dependencies unless explicitly enabled. This roadmap outlines the planned evolution of the project while preserving its **offline-friendly, no-nonsense, LAN-focused** design. Please note that these goals are subject to change and are merely ideas. Not all features will be implemented.

---

### Core UX & Stability
* [x] *(Planned)* Responsive UI layout
* [x] *(Planned)* Web frontend embedded using `embed.FS`
* [x] Add loading state or skeleton UI while games load
* [x] Improve mobile spacing and responsive typography

  - Search and evenly spaced toolbar controls use separate rows on narrow screens
  - Mobile view, although not entirely necessary as this application is geared towards PC libraries
  - If geared towards mobile, can consider APK file type filter or dedicated tab
* [x] *(Planned)* Manual refresh button
* [x] Integrate refresh button into GAMESHELF header text and remove button
* [x] Make the header refresh control keyboard-accessible
* [ ] Add theme support (drop-in CSS files)
* [x] *(Planned)* Add micro-animations for hover and card transitions
* [ ] Add optional About/Version info box within game card

* [x] Add a read-only game information panel and show the app version in Settings
* [x] *(Planned)* Add grid/list view toggle (due to image size restrictions, list view would need to be a "without cover art" mode)
* [ ] Add a toggle UI effects option

* [x] Add a slow-motion setting for dice and card-shuffle animations

* [x] Add settings for button hints, game title banners, and placeholder artwork
* [x] Respect the device's reduced-motion preference
* [ ] Add a dark/light mode toggle
* [x] Integrate download button into card main body
* [x] Add graceful fallback UI when `/api/games` fails
  - Show an error with retry; keep the last loaded cards when refresh fails
* [ ] Toggle for "Game card is download button"

### Artwork Enhancements
* [x] Ensure user-supplied artwork always overrides auto-detected art
* [x] *(Planned)* Placeholder artwork fallback
* [ ] *(Planned)* Add optional external artwork fetching (IGDB / RAWG / SteamGridDB)
  - Env to include, optional 
* [ ] Cache fetched artwork locally
  - If cached, skip fetch
* [x] Add ability to upload and edit cover images from the UI while keeping game folders read-only

### Metadata & Sorting
* [ ] Parse `.json`, `.info`, or GOG manifest metadata offline
* [x] *(Planned)* Add sorting options (name and size)
* [ ] Add date-added sorting once its meaning and data source are defined

* [x] Persist each game's first-seen date in a local JSON state file outside the read-only library
* [x] Export saved first-seen dates from Settings for backup
* [ ] Add client-side filtering (genre, developer, year)
* [ ] Add “Recently Added” section
* [x] Add functional search bar
* [x] Add a dice icon and randomize logic from parsed folder names to suggest a game download
* [ ] Add ability to group games together by adding tags (requires lightweight database integration)
* [x] Reintroduce "no games found" subheader directing users where to store/add games
    * [x] Create a second error message and link it to search when no games are found
* [x] Reintroduce an accessible "x" to clear the search bar

### Downloads & File Handling
* [x] *(Planned)* ZIP download streaming
* [x] *(Planned)* Display calculated download size in game information

* [x] Show a read-only list of the selected game's files in its information panel
* [x] Download individual files directly from the file list
* [x] *(Planned)* Folder autodiscovery
* [ ] Add multi-select mode for downloading multiple folders ("bulk download" option)
* [ ] Add optional GOG API integration for automatic downloads (account-based, but reduces the need for manual transfers)
  - Env to include, optional 
* [ ] Add support for multiple directories
* [ ] Explore a first-launch setup page for library paths, multiple directories, and clearly explained download/ZIP streaming options; define where settings persist and preserve read-only library access
* [x] Keep cover reads and ZIP contents within the selected game directory, including symlinks and files changed during a request; preserve uploaded covers under application data
* [x] Handle unreadable files and interrupted ZIP downloads cleanly; close each file after streaming and abort partial archives

### Administration, Security & LAN
* [ ] Add local-only analytics (downloads, refresh history, recent activity)
* [ ] Add `/api/stats` for UI integrations
* [x] Detect game ID collisions so similarly named folders cannot hide each other (persist ordinary slugs and deterministic SHA-256 suffixes; preserve folder-based metadata)

### Docker / GHCR
* [ ] Add multi-arch builds (amd64 + arm64)
* [x] *(Planned)* Environment variable configuration
* [x] Add a responsible distribution use/disclaimer statement tp README
* [ ] Additional logging outputs
> [!NOTE]
> For substantial features that are beyond the minimal design approach, separate versions should be created (eg. "gameshelf:plus-gog", "gameshelf:plus-auto-search", etc.)
