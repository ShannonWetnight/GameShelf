# GameShelf releases

`main` contains the public application and stable publication tooling. Tests, fixtures, smoke scripts, security reports, and experimental packaging stay on `edge`.

| Action | Purpose |
| --- | --- |
| Edge tests and prerelease | Run development checks and optionally publish an Edge prerelease. The small launcher on main starts the implementation on Edge. |
| Publish stable release | Check the public file list, request verification of the exact main commit on Edge, and publish its verified bundle under a new stable tag. |

## Development

Work and test on `edge`. Run **Edge tests and prerelease** with **publish** unchecked for downloadable test packages, or checked to create a prerelease and update `:edge`. Test reports remain in Edge run artifacts and test packages.

To prepare a release PR, commit the version notes on Edge and run **Edge tests and prerelease** from `edge` with `promote_version` set to that version. After the tests pass, the promotion job starts from main and copies only approved application paths and that version's notes into a draft main PR. It preserves main's README, roadmap, workflow files, and release helpers. Review the draft before merging. Do not merge the entire Edge branch into main. The main file check rejects test folders, fixtures, smoke scripts, local test actions, and other files outside the public file list. Update the list deliberately when adding a new production file.

## Stable releases

1. Finish testing on Edge and promote the approved application changes to main.
2. Copy `.github/release-notes/TEMPLATE.md` to a new version file such as `.github/release-notes/v2.2.0.md`. Replace the placeholders with changes, upgrade instructions, and known issues. Commit it to main.
3. Run **Publish stable release** from `main` with that same version.

If the notes file is missing, commit it to main before starting a new workflow run. Re-running a failed older run uses its original commit and will still miss the new file.

The release Action validates the source, notes, and version, then starts the Edge harness against that exact main commit. Edge builds and tests a temporary copy using its own tests, scans builder and runtime images, and packages the verified image. It separately archives the pristine main checkout, so the public source archive contains no overlaid test files. Main downloads the package from that specific successful run and checks its source SHA and image ID before publication.

The public bundle contains the Linux amd64 Docker image archive, clean main source archive, version-specific Compose file, license, change notes, build metadata, and SHA-256 checksums. Test fixtures and verification reports are excluded. Notes contain only the reviewed, brief change summary. GitHub's automatic source downloads also follow the clean main tag.

Publication creates a matching source tag without moving existing tags, uploads a draft release, publishes it, and finally updates `:latest`. Edge prereleases update only `:edge`. A failed check or scan blocks publication. Existing releases cannot be overwritten. An interrupted publication can leave a draft or a versioned image; inspect its run before retrying. GitHub and GHCR cannot be updated as one transaction.

## Maintainer files

Keep release instructions here, stable helpers in `.github/scripts/`, version notes in `.github/release-notes/`, and Actions in `.github/workflows/`. The main README is for installation and usage. Do not recreate top-level `docs/` or `scripts/` on main. Tests and promotion tooling stay on Edge.

## Promotion safeguards

The promotion copies `Dockerfile`, `main.go`, `go.mod`, optional `go.sum`, `docker-compose.yml`, approved assets under `web/` and `images/`, and only the requested version's notes. Deletions in those application paths are preserved. It validates the resulting complete file list using main's own release guard. Maintainer files, test files, fixture directories, and Edge change notes are never copied. Production README or roadmap changes require a separate reviewed change on main.

The promotion creates a new branch and draft PR; it does not merge or publish. To avoid relying on PR-event triggering or approval for an automation-created PR, promotion explicitly dispatches main's **Publish stable release** workflow with `check_only` enabled on the new branch. That run checks the public file list and skips verification/publication. Repository Actions settings must allow GitHub Actions to create pull requests.

Make the `public-files` check required in main's branch protection or ruleset to prevent merging a failing PR. The workflow itself also blocks publication even if that merge protection has not been configured.

## Branch setup

Install the consolidated main paths first, then the matching Edge change before running stable verification or promotion. Keep the full Edge workflow and test files there. Main needs only the Edge launcher to expose the Action in GitHub's menu; it does not contain or run the test implementation.

The built-in `GITHUB_TOKEN` needs Actions write access to dispatch and wait for Edge verification, and contents/package write access in the stable publication job. The workflows request these permissions by job. If tag rules or package permissions reject publication, adjust the repository rules for its release workflow.


## Release-note format

Use only `Changes`, `Fixed`, `Added`, `Other`, and `Security` as level-two headings. Omit empty sections and keep bullets to one short sentence where practical. Describe the user-visible result; group related changes. Put patched security issues under `Security`, naming a CVE only when verified. Keep any essential upgrade action to a brief bullet in the relevant section.

Do not append installation instructions, limitations, commit lists, source SHAs, container references, image digests, or build details to the public notes. Installation belongs in README; source and image identity belong in `release.json` and the Action summary. Update the version notes for each stable release and `.github/release-notes/edge.md` for each Edge test release.
