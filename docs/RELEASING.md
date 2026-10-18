# Edge testing and release preparation

This branch owns the backend tests, frontend tests, Docker smoke checks, scan scripts, fixtures, and test package generation. Keep these files on Edge. Promote reviewed application files and versioned release notes individually to main rather than merging this entire branch.

Run **Edge tests and prerelease** from `edge`. Leave **publish** unchecked for a downloadable package, or check it to create a prerelease and update `:edge`. Pushes and pull requests to Edge run the same verification without publishing. Update `.github/release-notes/edge.md` with the changes being tested. Notes also record commits since the previous Edge release.

The optional `source_sha`, `stable_version`, and `request_id` inputs are used by main's stable release Action. Leave them blank for development builds. Main requests verification of an exact main commit. The harness checks out that commit separately, overlays Edge's tests into a temporary copy, and runs application tests, Docker smoke tests, and vulnerability scans there. Test reports stay in Edge artifacts. A stable package contains the verified image and an archive of the pristine main checkout, with no test overlay or reports.

The main release Action downloads the package from that exact successful Edge run, verifies its source SHA and image ID, and publishes it. Edge never publishes a stable request. Missing notes, failing tests, scan errors, and HIGH/CRITICAL findings stop the process.

Install this Edge change before the main cleanup. Main retains only a launcher for Edge testing and stable publication tooling. Its file check prevents a broad merge from bringing this harness into the public source tree. Keep release helpers compatible across branches when maintaining the process.
