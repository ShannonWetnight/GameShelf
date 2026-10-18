# GameShelf releases

Use the two workflows in the repository's **Actions** tab:

| Workflow | When it runs | What it produces |
| --- | --- | --- |
| Edge tests and prerelease | Pushes to `edge`, pull requests to `main` or `edge`, or a manual run from `edge` | Tested Docker package and reports. A manual run with **publish** checked also creates an Edge prerelease and updates `:edge`. |
| Publish stable release | Manual run from `main` with a version such as `v1.2.3` | Tested package, version tag, public GitHub release, versioned Docker image, and updated `:latest`. |

Branch pushes never publish a stable release. An Edge prerelease never becomes GitHub's latest release or updates the Docker `:latest` tag.

## Test work on Edge

1. Push your changes to `edge`. Update `.github/release-notes/edge.md` with the changes being tested, upgrade requirements, and known issues.
2. Open **Actions → Edge tests and prerelease**. The push starts verification automatically. You can also select **Run workflow**, choose `edge`, and leave **publish** unchecked.
3. After the run succeeds, download its `gameshelf-edge-...` artifact. Extract the artifact ZIP, then run `sha256sum -c SHA256SUMS.txt` in that directory.
4. Load the Docker archive with `docker load -i gameshelf-edge-...-linux-amd64.docker.tar.gz`, using the actual filename. Edit the included `docker-compose.yml` to point at a test collection, then run `docker compose up -d`. Use a different host port and Compose project name if your normal instance is already running.

For a shareable test release, run the workflow manually from `edge` and check **publish**. It creates a unique tag such as `edge-20261018-123456789.1-abcdef123456`, marks the GitHub release as a prerelease, pushes that versioned image, and then updates `ghcr.io/shannonwetnight/gameshelf:edge`. Re-running a workflow uses a new attempt number so it cannot replace the earlier test package.

The notes include your Edge summary plus the commits since the previous Edge prerelease reachable from that branch. If there is no previous Edge tag, they include the branch's commit history. Pull requests receive test packages but cannot publish.

## Publish from main

1. Finish testing on Edge and merge the intended changes into `main`.
2. Copy `.github/release-notes/TEMPLATE.md` to `.github/release-notes/v1.2.3.md`, using the new version. Replace every placeholder with the release's changes, upgrade instructions, and known issues. Include changes since the last stable release, including relevant Edge work. Commit the notes to `main`.
3. Open **Actions → Publish stable release → Run workflow**. Select `main`, enter the same version, and start the run.
4. When it succeeds, open the linked GitHub release. Its assets and Docker image come from the same tested source commit.

The workflow creates the tag; you do not need to push one beforehand. Stable versions use `vMAJOR.MINOR.PATCH` and must increase beyond stable tags reachable from the release commit. A tag pointing to another commit stops the run. Existing GitHub releases cannot be overwritten. Notes must exist for that exact version and include at least one change bullet; empty notes and template placeholders stop publication. The workflow also appends included commits and a comparison link, so each release records its actual source changes. Maintainers still need to review the notes for accuracy and completeness.

## What verification covers

Both workflows use the same checks: Go vet and backend tests, frontend syntax and behavior tests, Docker startup and API requests, cover images and nested ZIP downloads, refresh failure and recovery, non-root identities and file permissions, and read-only operation with capabilities dropped. Trivy scans both the builder and runtime images. Any HIGH or CRITICAL finding, including an unfixed one, blocks packaging and publication. Scan errors also stop the run. Lower-severity findings remain in the reports for review.

The backend, frontend, Docker, and release validation tests run within these two workflows.

The Dockerfile currently builds Linux amd64 only. These workflows preserve that platform; the archives are Docker images, rather than native Windows executables. The scanner remains at the version used by the previous GameShelf verification workflow, `0.76.0`. Review scanner and base-image versions when maintaining the release tooling.

## Release assets and source integrity

Each package contains the Docker image archive, source archive, verification archive, `LICENSE`, version-specific `docker-compose.yml`, `RELEASE-NOTES.md`, `release.json`, and `SHA256SUMS.txt`. Run artifacts are retained for 14 days on Edge and 30 days for stable builds; published release assets remain available until removed.

Publication downloads the successful test job's package from the same workflow run, verifies its checksums, loads the image, and checks its image ID against the recorded tested image. It creates a missing tag without forcing a reference update, then checks that the tag resolves to the package's source commit. The GitHub release and source downloads therefore use the same commit as the image. The public release notes also record the registry image digest; the downloaded run artifact has the pre-publication notes.

## Failures and retrying

A failed test or scan leaves verification reports in the run's artifacts and publishes nothing. Correct the issue and run again.

Publication pushes the versioned image, creates a draft release with all assets, publishes the release, and finally advances the channel tag. GitHub and GHCR cannot be updated in one transaction. A failure can leave a source tag, versioned image, draft release, or a published release whose channel tag still points to the previous image. Published releases are never silently replaced.

If a run stops after creating a draft, inspect its logs and assets before deleting that unpublished draft and retrying the original run. Retry the original workflow run to retain its source commit. A matching source tag can be reused while no release exists. If a public release exists, use a new version for a new build. If only the channel update failed, restore `:edge` or `:latest` to the recorded version's image digest after checking the release; do not rebuild the version or move its source tag.

## Repository settings

GitHub Actions must be allowed to write repository contents and GHCR packages. The workflows request those permissions only in their publication jobs and use the built-in `GITHUB_TOKEN`; no personal token or signing service is required. Existing package permissions and tag rules must allow this repository's workflow to publish and create new version tags. Read-only test jobs do not receive publication permissions.

Merge the workflow files into `main` first so manual runs appear in Actions, then merge `main` into `edge` so Edge has the same workflow scripts. Keep both branches' release tooling synchronized when changing the process. These workflows do not merge branches or run a release simply because their setup is merged.
