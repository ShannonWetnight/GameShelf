# GameShelf releases

`main` contains the public application and stable publication tooling. Tests, fixtures, smoke scripts, security reports, and experimental packaging stay on `edge`.

| Action | Purpose |
| --- | --- |
| Edge tests and prerelease | Run development checks and optionally publish an Edge prerelease. The small launcher on main starts the implementation on Edge. |
| Publish stable release | Check the public file list, request verification of the exact main commit on Edge, and publish its verified bundle under a new stable tag. |

## Development

Work and test on `edge`. Run **Edge tests and prerelease** with **publish** unchecked for downloadable test packages, or checked to create a prerelease and update `:edge`. Test reports remain in Edge run artifacts and test packages.

Promote only reviewed application changes and version-specific release notes to `main`. Do not merge the entire Edge branch into main. The main file check rejects test folders, fixtures, smoke scripts, local test actions, and other files outside the public file list. Update the list deliberately when adding a new production file.

## Stable releases

1. Finish testing on Edge and promote the approved application changes to main.
2. Copy `.github/release-notes/TEMPLATE.md` to a new version file such as `.github/release-notes/v2.2.0.md`. Replace the placeholders with changes, upgrade instructions, and known issues. Commit it to main.
3. Run **Publish stable release** from `main` with that same version.

The release Action validates the source, notes, and version, then starts the Edge harness against that exact main commit. Edge builds and tests a temporary copy using its own tests, scans builder and runtime images, and packages the verified image. It separately archives the pristine main checkout, so the public source archive contains no overlaid test files. Main downloads the package from that specific successful run and checks its source SHA and image ID before publication.

The public bundle contains the Linux amd64 Docker image archive, clean main source archive, version-specific Compose file, license, change notes, build metadata, and SHA-256 checksums. Test fixtures and verification reports are excluded. Notes include the maintained summary and the included commits since the previous stable release. GitHub's automatic source downloads also follow the clean main tag.

Publication creates a matching source tag without moving existing tags, uploads a draft release, publishes it, and finally updates `:latest`. Edge prereleases update only `:edge`. A failed check or scan blocks publication. Existing releases cannot be overwritten. An interrupted publication can leave a draft or a versioned image; inspect its run before retrying. GitHub and GHCR cannot be updated as one transaction.

## Branch setup

Install the Edge tooling change on `edge` before using the revised stable Action. Keep the full Edge workflow and test files there. Main needs only the Edge launcher to expose the Action in GitHub's menu; it does not contain or run the test implementation.

The built-in `GITHUB_TOKEN` needs Actions write access to dispatch and wait for Edge verification, and contents/package write access in the stable publication job. The workflows request these permissions by job. If tag rules or package permissions reject publication, adjust the repository rules for its release workflow.
