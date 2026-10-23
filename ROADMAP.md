# GameShelf Roadmap

GameShelf is intentionally minimalist: no accounts, no databases, no external dependencies unless explicitly enabled. This roadmap outlines the planned evolution of the project while preserving its **offline-friendly, no-nonsense, LAN-focused** design. Please note that these goals are subject to change and are merely ideas. Not all features will be implemented.

---

### Recommended Next
* [x] Add a validated restore flow for exported library backups, with a preview and selection before replacing saved data; keep the mounted game library read-only.
* [ ] Add an optional download queue for selecting several games and creating one ZIP, with clear size estimates and cancellation before packaging.

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
* [x] Add System, GameShelf Classic, Light, and Dark themes in Appearance settings
* [x] *(Planned)* Add micro-animations for hover and card transitions
* [x] Add a game-card information button that opens a read-only details panel; show the app version in Settings
* [x] *(Planned)* Add grid/list view toggle with optional cover thumbnails in list view
* [ ] Add a toggle UI effects option

* [x] Add a slow-motion setting for dice and card-shuffle animations

* [x] Add settings for button hints, game title banners, and placeholder artwork
* [x] Add separate card-star visibility and favorited-only display options in grid and list views
* [x] Add an All option to clear sort/filter selection and a logo shortcut back to the default grid
* [x] Respect the device's reduced-motion preference
* [x] Add a light/dark mode selector that can follow the device preference
* [x] Integrate download button into card main body
* [x] Add graceful fallback UI when `/api/games` fails
  - Show an error with retry; keep the last loaded cards when refresh fails
* [ ] Toggle for "Game card is download button"

### Artwork Enhancements
* [x] Ensure user-supplied artwork always overrides auto-detected art
* [x] *(Planned)* Placeholder artwork fallback
* [ ] *(Planned)* Add optional external artwork fetching (IGDB / RAWG / SteamGridDB)
  - Env to include, optional 
  - [ ] If enabled, cache fetched artwork locally and skip the remote fetch when a cached copy exists
* [x] Add ability to upload and edit cover images from the UI while keeping game folders read-only
* [x] Export uploaded and available game-folder covers with library data; exclude placeholder artwork
* [x] Show compact game covers in list view by default, with a setting to hide them

### Metadata & Sorting
* [ ] Parse `.json`, `.info`, or GOG manifest metadata offline
* [x] *(Planned)* Add sorting options (name and size)
* [ ] Add date-added sorting once its meaning and data source are defined

* [x] Persist each game's first-seen date in a local JSON state file outside the read-only library
* [x] Save GameShelf-only title edits alongside first-seen dates without changing game folders
* [x] Export saved first-seen dates, title edits, and artwork from Settings for backup
* [ ] Add client-side filtering (genre, developer, year)
* [x] Add a “Recently Added” filter with a configurable date range
* [x] Save favorites locally and filter the library to favorite games
* [x] Offer a default-on setting that places favorites first within every sort and filter
* [x] Restore selected title, cover, and favorite metadata to their detected defaults with confirmation
* [x] Add functional search bar
* [x] Add a dice icon and randomize logic from parsed folder names to suggest a game download
* [ ] Add ability to group games together by adding tags (requires lightweight database integration)
* [x] Reintroduce "no games found" subheader directing users where to store/add games
    * [x] Create a second error message and link it to search when no games are found
* [x] Reintroduce an accessible "x" to clear the search bar

### Downloads & File Handling
* [x] *(Planned)* ZIP download streaming
* [x] *(Planned)* Display calculated download size in game information

* [x] Open a read-only file list from the file count below Download Game
* [x] Download individual files directly from the file list
* [x] Show a brief download-started notification for game ZIPs and individual files
* [x] Select metadata and individual game cover folders when exporting library data
* [x] Include optional server settings and recent application logs in the export
* [x] Confirm successful title, cover, favorite, settings, metadata-reset, and export actions with a notification banner
* [x] *(Planned)* Folder autodiscovery
* [ ] Add multi-select mode for downloading multiple folders ("bulk download" option)
* [ ] Add optional GOG API integration for automatic downloads (account-based, but reduces the need for manual transfers)
  - Env to include, optional 
* [ ] Add support for multiple directories
* [ ] Explore a first-launch setup page for library paths, multiple directories, and clearly explained download/ZIP streaming options; define where settings persist and preserve read-only library access
* [x] Let users save mounted library and data paths and the refresh interval from Settings, applying path and interval changes after restart
* [x] Keep cover reads and ZIP contents within the selected game directory, including symlinks and files changed during a request; preserve uploaded covers under application data
* [x] Handle unreadable files and interrupted ZIP downloads cleanly; close each file after streaming and abort partial archives

### Administration, Security & LAN
* [ ] Add local-only analytics (downloads, refresh history, recent activity)
* [x] Add `/api/stats` for UI integrations (read-only counts, total indexed bytes, covered games, and last successful scan time)
* [x] Detect game ID collisions so similarly named folders cannot hide each other (persist ordinary slugs and deterministic SHA-256 suffixes; preserve folder-based metadata)

### Docker / GHCR
* [ ] Add multi-arch builds (amd64 + arm64)
* [x] *(Planned)* Environment variable configuration
* [x] Add a responsible distribution use/disclaimer statement tp README
* [x] Add a verbose logging option and an exportable bounded log snapshot
> [!NOTE]
> For substantial features that are beyond the minimal design approach, separate versions should be created (eg. "gameshelf:plus-gog", "gameshelf:plus-auto-search", etc.)
