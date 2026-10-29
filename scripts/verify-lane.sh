#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  unit)
    common=(--rm --user 10002:10003 --env HOME=/tmp --env GOCACHE=/cache/build --env GOMODCACHE=/cache/mod
      --mount "type=bind,src=$CI_CACHE_ROOT/go,dst=/cache"
      --mount "type=bind,src=$PWD,dst=/src,readonly" --workdir /src --entrypoint sh)
    docker run "${common[@]}" gameshelf:builder -ec 'go vet ./...; go test -v ./...'
    docker run "${common[@]}" gameshelf:builder -ec 'cd connectors/rclone; go vet ./...; go test -v ./...'
    # Reuse the same compiler cache for the host's live browser integration binary.
    chmod a+rwx reports
    docker run "${common[@]}" --env CGO_ENABLED=0 --mount "type=bind,src=$PWD/reports,dst=/src/reports" \
      gameshelf:builder -ec 'go test -c -o reports/gameshelf-tests'
    GAMESHELF_LIVE_PROFILES=1 ./reports/gameshelf-tests -test.run '^TestFamilyProfilesLiveBrowser$' -test.v
    rm reports/gameshelf-tests
    bash "$GITHUB_WORKSPACE/tooling/tests/test-publish-edge.sh"
    PUBLIC_RELEASE_SCRIPT="$GITHUB_WORKSPACE/candidate/.github/scripts/release.py" \
      python3 -m unittest discover -s "$GITHUB_WORKSPACE/tooling/tests" -p 'test_*.py' -v
    ;;
  browser)
    for file in web/*.js tests/*.cjs; do node --check "$file"; done
    # Discover every suite, including newly added profile regressions, without a hand-maintained list.
    node tests/browser-pool.cjs -- node --test --test-concurrency=1 tests/*.test.cjs
    ;;
  containers) python3 -u scripts/docker-smoke.py gameshelf:candidate ;;
  network)
    python3 -u scripts/network-smoke.py gameshelf:candidate
    python3 -u scripts/network-containment.py gameshelf:candidate --report reports/network-containment.json
    ;;
  smb) python3 -u scripts/smb-write-smoke.py gameshelf:candidate ;;
  scan) bash scripts/scan.sh ;;
  *) echo "Unknown verification lane: $1" >&2; exit 1 ;;
esac
