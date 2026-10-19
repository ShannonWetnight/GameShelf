# Edge testing and release preparation

This branch owns the backend tests, frontend tests, Docker smoke checks, scan scripts, fixtures, and test package generation. Keep these files on Edge. Keep promotion selective; never merge this entire branch into main. Run **Edge tests and prerelease** from Edge with `promote_version` set to the planned stable version and **publish** unchecked. This does not tag or publish Edge with that version. After verification, the promotion job starts from main, copies only application paths, creates draft stable notes from main's template, and opens a draft release PR. Complete those notes on the PR branch before merging. Main's README, roadmap, and release automation remain unchanged. Tests, fixtures, and Edge notes are excluded. Application-file deletions are preserved.

Run **Edge tests and prerelease** from `edge`. Leave **publish** unchecked for a downloadable package, or check it to create a prerelease and update `:edge`. Pushes and pull requests to Edge run the same verification without publishing. Update `.github/release-notes/edge.md` with the changes being tested. Keep notes brief and update the Edge summary for each test release.

The optional `source_sha`, `stable_version`, and `request_id` inputs are used by main's stable release Action. Leave them blank for development builds. Main requests verification of an exact main commit. The harness checks out that commit separately, overlays Edge's tests into a temporary copy, and runs application tests, Docker smoke tests, and vulnerability scans there. Test reports stay in Edge artifacts. A stable package contains the verified image and an archive of the pristine main checkout, with no test overlay or reports.

The main release Action downloads the package from that exact successful Edge run, verifies its source SHA and image ID, publishes the Docker image to GHCR, and creates a stable source release. Stable releases expose only GitHub's automatic source downloads and brief notes. The verification package remains an Actions artifact; its archives, Compose copy, metadata, and checksums are not uploaded to the stable release. Edge test packages and prereleases retain their downloadable bundles. Edge never publishes a stable request. Unfinished notes, failing tests, scan errors, and HIGH/CRITICAL findings stop the process.

Install this Edge change before the main cleanup. Main retains only a launcher for Edge testing and stable publication tooling. Its file check prevents a broad merge from bringing this harness into the public source tree. Keep release helpers compatible across branches when maintaining the process.


Main keeps its maintainer guide in `.github/RELEASING.md` and stable helpers in `.github/scripts/`. The general-user README on main contains no release procedure. Do not promote top-level `docs/` or `scripts/` into main. Main's `public-files` check validates the complete candidate tree before a release; require that check in main's branch rules to block merges as well.

Install the main folder cleanup before this Edge path update. Promotion requires the repository setting that allows GitHub Actions to create pull requests. It explicitly dispatches a `check_only` run of main's release workflow on the draft branch to avoid relying on PR-event triggering or approval for an automation-created PR. That run validates files and skips publication. Promotion opens a draft; it never merges it or publishes a stable release.


## Release-note format

The generator adds the standard GameShelf cover image, a `vX.Y.Z Changes` heading (the actual tag for Edge), and blank-line spacing. Keep this header out of the maintained notes files; their sections become level-three headings in the published body.

Use only `Changes`, `Fixed`, `Added`, `Other`, and `Security` as level-two headings. Omit empty sections and keep bullets to one short sentence where practical. Describe the user-visible result; group related changes. Put patched security issues under `Security`, naming a CVE only when verified. Keep any essential upgrade action to a brief bullet in the relevant section.

Do not append installation instructions, limitations, commit lists, source SHAs, container references, image digests, or build details to the public notes. Installation belongs in README; source and image identity belong in `release.json` and the Action summary. Complete the draft version notes on the main PR branch for each stable release, and update `.github/release-notes/edge.md` for each Edge test release.
