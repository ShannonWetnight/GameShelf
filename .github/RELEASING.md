# GameShelf releases

`main` contains the public application and stable publication tooling. Tests, fixtures, smoke scripts, security reports, and experimental packaging stay on `edge`.

| Action | Purpose |
| --- | --- |
| Edge tests and Docker image | Run development checks and optionally update the Edge Docker image without creating a GitHub Release. The small launcher on main starts the implementation on Edge. |
| Publish stable release | Check the public file list, request verification of the exact main commit on Edge, and publish its verified Docker image and create a source release under a new stable tag. |

## Development

Work and test on `edge`. Run **Edge tests and Docker image** with **publish** unchecked for downloadable Actions artifacts, or checked to publish a verified, versioned image and update `:edge`. This does not create an Edge Git tag or GitHub Release. Test reports remain in Edge run artifacts and test packages.

To prepare a release PR, run **Edge tests and Docker image** from `edge` with `promote_version` set to the planned stable version and **publish** unchecked. This does not tag Edge with that version. After the tests pass, the promotion job starts from main, copies only approved application paths, and adds draft version notes from main's template to a draft main PR. Complete the notes on that PR branch before merging. It preserves main's README, roadmap, workflow files, and release helpers. Do not merge the entire Edge branch into main. The main file check rejects test folders, fixtures, smoke scripts, local test actions, and other files outside the public file list. Update the list deliberately when adding a new production file.

## Stable releases

1. Finish testing on Edge and open the draft promotion PR against main.
2. Complete the generated `.github/release-notes/vX.Y.Z.md` in that PR. Replace the placeholders with brief changes, omit empty sections, review the application changes, and merge the PR.
3. Run **Publish stable release** from `main` with that same version.

If the notes file is missing, commit it to main before starting a new workflow run. Re-running a failed older run uses its original commit and will still miss the new file.

The release Action validates the source, notes, and version, then starts the Edge harness against that exact main commit. Edge builds and tests a temporary copy using its own tests, scans builder and runtime images, and packages the verified image. It separately archives the pristine main checkout for the internal verification package. Main downloads the package from that specific successful run and checks its source SHA and image ID before publication.

The public release contains brief change notes and exactly three uploaded assets: the verified Docker archive, the pristine main source archive, and `SHA256SUMS.txt` containing checksums for those two archives. GitHub also adds its automatic Source code (zip) and Source code (tar.gz) links to every tagged release; the workflow cannot remove those links. Publish the verified Docker image to GHCR. Keep Compose copies, metadata, and verification reports in Actions artifacts. The source archives include the license and Compose file.

Publication creates a matching source tag without moving existing tags, creates a draft release with those three assets, publishes it, and finally updates `:latest`. Edge image runs publish a versioned GHCR image and update only `:edge`; they create no Git tag or GitHub Release. A failed check or scan blocks publication. Existing releases cannot be overwritten. An interrupted publication can leave a draft or a versioned image; inspect its run before retrying. GitHub and GHCR cannot be updated as one transaction.

## Maintainer files

Keep release instructions here, stable helpers in `.github/scripts/`, version notes in `.github/release-notes/`, and Actions in `.github/workflows/`. The main README is for installation and usage. Do not recreate top-level `docs/` or `scripts/` on main. Tests and promotion tooling stay on Edge.

## Promotion safeguards

The promotion copies `Dockerfile`, `main.go`, `go.mod`, optional `go.sum`, `docker-compose.yml`, and approved assets under `web/` and `images/`. It also creates the planned version's draft notes from main's template. Deletions in application paths are preserved. It validates the resulting complete file list using main's own release guard. Maintainer files, test files, fixture directories, and Edge change notes are never copied. Production README or roadmap changes require a separate reviewed change on main.

The promotion creates a new branch and draft PR; it does not merge or publish. To avoid relying on PR-event triggering or approval for an automation-created PR, promotion explicitly dispatches main's **Publish stable release** workflow with `check_only` enabled on the new branch. That run checks the public file list and skips verification/publication. Repository Actions settings must allow GitHub Actions to create pull requests.

Make the `public-files` check required in main's branch protection or ruleset to prevent merging a failing PR. The workflow itself also blocks publication even if that merge protection has not been configured.

## Branch setup

Install the consolidated main paths first, then the matching Edge change before running stable verification or promotion. Keep the full Edge workflow and test files there. Main needs only the Edge launcher to expose the Action in GitHub's menu; it does not contain or run the test implementation.

The built-in `GITHUB_TOKEN` needs Actions write access to dispatch and wait for Edge verification, and contents/package write access in the stable publication job. The workflows request these permissions by job. If tag rules or package permissions reject publication, adjust the repository rules for its release workflow.


## Release-note format

The generator adds the standard GameShelf cover image, a versioned Changes heading (the Edge Docker image tag for Edge), and blank-line spacing. Keep this header out of the maintained notes files; their sections become level-three headings in the published body.

Use only `Changes`, `Fixed`, `Added`, `Other`, and `Security` as level-two headings. Omit empty sections and keep bullets to one short sentence where practical. Describe the user-visible result; group related changes. Put patched security issues under `Security`, naming a CVE only when verified. Keep any essential upgrade action to a brief bullet in the relevant section.

Do not append installation instructions, limitations, commit lists, source SHAs, container references, image digests, or build details to the public notes. Installation belongs in README; source and image identity belong in the Actions artifact's `release.json` and the Action summary. Update the version notes for each stable release and `.github/release-notes/edge.md` for each Edge test release.
