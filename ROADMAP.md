# GameShelf Roadmap

GameShelf is intentionally minimalist: no accounts, no databases, no external services required for local libraries. This roadmap outlines the planned evolution of the project while preserving its **offline-friendly, no-nonsense, LAN-focused** design. Please note that these goals are subject to change and are merely ideas. Not all features will be implemented.

---

### Recommended Next
* [x] Add a Library Health panel with per-source status, last successful connection check, manual retry, scheduled checks, and exportable history. Keep offline catalogs visible while diagnosing a source.
* [ ] Add **Library View**: filter by a named library instead of All Sources, with its health indicator beside the source name.
* [ ] Add authenticated owner/member access and secure first-owner enrollment for deployments that need identities beyond the shared family PIN.
* [ ] Prioritize the network read-only safeguards review below, including guidance to use dedicated read-only share accounts.
* [x] Add a validated restore flow for exported library backups, with a preview and selection before replacing saved data; keep the mounted game library read-only.
* [x] Add an optional download Playlist for choosing several games, reviewing their estimated size, and creating one ZIP.
* [x] Add a first-launch setup guide for library and data mounts, including a path check and clear guidance for read-only library access.

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
* [x] Add System, GameShelf Classic, Light, Dark, and Retro Arcade themes in Appearance settings
* [x] *(Planned)* Add micro-animations for hover and card transitions
* [x] Add a game-card information button that opens a read-only details panel; show the app version in Settings
* [x] *(Planned)* Add grid/list view toggle with optional cover thumbnails in list view
* [x] Add tile-fill animation on library load and refresh, plus separate loaded-tile animation and an animation speed slider from off to 3.0×
* [x] Add Basic and Advanced Settings views with a sliding selector

* [x] Synchronize dice/card shuffle speed with the global animation slider

* [x] Add settings for button hints, game title banners, and placeholder artwork
* [x] Keep favorited stars pinned by default, with hover-only controls available in both views
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
* [x] Let the cover editor choose a supported image already inside a game's folder
* [x] Export uploaded and available game-folder covers with library data; exclude placeholder artwork
* [x] Show compact game covers in list view by default, with a setting to hide them

### Metadata & Sorting
* [ ] Parse `.json`, `.info`, or GOG manifest metadata offline
* [x] *(Planned)* Add sorting options (name and size)
* [x] Sort Recently Added by persisted first-seen date

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
* [ ] Add offline tags and collections using the existing app metadata storage
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
* [x] Add an optional Playlist to download multiple game folders in one ZIP
* [ ] Add optional GOG API integration for automatic downloads (account-based, but reduces the need for manual transfers)
  - Env to include, optional 
* [x] Add support for multiple local or host-mounted library directories
* [x] Add direct SMB, NFS, SFTP, WebDAV, FTP, and FTPS connections with encrypted passwords, pinned SFTP host keys, confined paths, and read-only connector commands
* [x] Add a first-launch setup page for library paths, multiple directories, and clearly explained download/ZIP streaming options; define where settings persist and preserve read-only library access
* [x] Let users save mounted library and data paths and the refresh interval from Settings, applying library and interval changes immediately; data-location changes still require restart
* [x] Keep cover reads and ZIP contents within the selected game directory, including symlinks and files changed during a request; preserve uploaded covers under application data
* [x] Handle unreadable files and interrupted ZIP downloads cleanly; close each file after streaming and abort partial archives

### Network Library Read-Only Safeguards (Future Review)
GameShelf currently limits network library access to read operations, but a network account with write permissions retains those permissions on the remote server. Application safeguards do not replace server-enforced read-only access.

* [ ] **First: add a clear disclaimer** in first-time Network setup and the Library Sources editor. Explain that GameShelf only performs read operations, but supplied credentials may still have write permissions; recommend a dedicated read-only account/share. Keep the wording consistent with the README.
* [ ] Explicitly reject unsupported network connector operations at the backend boundary rather than treating every non-list operation as a read.
* [ ] Review remote path validation and containment across scans, artwork, individual downloads, and ZIP streams, including symlinks and paths that change during a request.
* [ ] Expand network smoke and regression tests using isolated SMB credentials that have read/write access. Verify scans, previews, and downloads leave the remote library unchanged; test that write/delete/rename operations are unavailable. Never perform destructive tests against a user's library.
* [ ] Review protocol-specific read-only file access and whether SMB can request only the minimum file and directory permissions needed. Evaluate the tradeoffs before replacing the existing limited rclone connector.
* [ ] Evaluate tighter connector process isolation, including source-specific credentials, approved destinations, least privilege, and a narrow read-only interface.
* [ ] Document the security boundary: container read-only filesystems and unprivileged execution do not revoke remote SMB account permissions. Server-side read-only credentials remain the strongest enforcement.

### Administration, Security & LAN
* [ ] **Family Controls user PINs:** optional local nicknames and unique PINs, with per-session themes, Guardian policies, allowed libraries, and potentially individual game access. Keep the default shared shelf free of mandatory sign-ins or external account services.
* [x] Add optional Settings-menu and Advanced-tab PIN gates, configurable Basic/Advanced placement, grouped Guardian controls, and complete session invalidation on PIN changes.
* [x] Consolidate library sources, health monitoring/history, and refresh into Library Manager; rate-limit manual discovery on the server.

Security is an ongoing product requirement, including server-enforced access rules, safe storage, read-only boundaries, recovery, and automated vulnerability checks.

* [x] Add Family Controls with a four-digit PIN, individual Allow / Require PIN / Disable policies and visibility, server-side action enforcement, scoped browser unlocks, and attempt limits.
* [x] Preserve family protection across Wipe/restore, export rules without PIN secrets, and require a new PIN on fresh restores.
* [x] Add Library Health with readable/degraded/critical states, bounded connection checks, monitor configuration, and backup/restore of recent history.
* [x] Use one app-themed tooltip system, shared icon feedback, and consistent cover-editor rotate/mirror/stretch controls.
* [x] Keep skipped setup recovery available in Basic settings, and scatter ten original GameShelf Edition cases below the welcome header.

* [ ] Add local-only analytics (downloads, refresh history, recent activity)
* [x] Add `/api/stats` for UI integrations (read-only counts, total indexed bytes, covered games, and last successful scan time)
* [x] Detect game ID collisions so similarly named folders cannot hide each other (persist ordinary slugs and deterministic SHA-256 suffixes; preserve folder-based metadata)

### Docker / GHCR
* [ ] Add multi-arch builds (amd64 + arm64)
* [x] *(Planned)* Environment variable configuration
* [x] Add a responsible distribution use/disclaimer statement to README
* [x] Add always-visible application logs with filters, customizable categories, unlimited default age with a 10 MB bound, optional age limits, and settings-change events
> [!NOTE]
> For substantial features that are beyond the minimal design approach, separate versions should be created (eg. "gameshelf:plus-gog", "gameshelf:plus-auto-search", etc.)


### Delivered Since the Original Plan
* [x] Mix up to 16 local and direct network locations with connection testing and editable saved credentials.
* [x] Preserve offline network catalogs across restarts; block downloads until reconnected and refreshed.
* [x] First-time setup with source selection, theme/schedule choices, import, deferred setup, and resuming unfinished setup.
* [x] Polished guided tour with a spotlight, read-only explanation, replay, and confirmed early exit.
* [x] Original GameShelf Edition artwork in the animated setup background.
* [x] Preview/import/export server configuration, safe display preferences, library metadata, covers, and logs; omit passwords and encryption keys with a sign-in warning.
* [x] Confirmed Reset All Settings, source removal, Playlist removal, and Playlist clearing.
* [x] Shared modal open/close motion and drag-safe backdrop dismissal.
* [x] Fifteen existing theme choices including System, plus Randomize on each visit; expressive themed logos, rain, stars, glitter, and a Midnight flashlight.
* [x] Proportional cover fitting with blurred gap filling across cards, lists, details, and shuffling; global stretch and saved per-game overrides.
* [x] List thumbnail expansion with Single-click, Double-click, and Disabled choices.
* [x] Advanced list opacity, card depth, hover names, matching animation controls, and theme transitions.
* [x] Automated browser/layout checks, real fixtures for six network protocols, restricted-container tests, and builder/runtime vulnerability gates.

### Family profiles and sharing
- [ ] Optional Family Controls initialization during setup: local nickname/PIN profiles, without sign-in accounts.
- [ ] Starter permission roles (Child, Adult, Administrator, Elevated User) plus custom roles/groups. Support as many profiles as available storage permits, with sensible management and abuse safeguards.
- [ ] Assign libraries and individual games to profiles/groups; retain each profile's preferences.
- [ ] Portable profile backups: nicknames, settings, roles, group memberships, permissions, library grants, and salted PIN verifiers (never plaintext). Design authenticated/encrypted backup handling and explicit owner approval before restoring security authority.
- [ ] Anonymous public live demo for the GameShelf website: isolated visitor sessions, disposable state, generic sample games, download/network limits, and abuse controls so visitors cannot collide or persist changes globally.
