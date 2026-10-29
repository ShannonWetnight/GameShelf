#!/usr/bin/env bash
# Exercise the Edge-only publishing path without Docker or GitHub credentials.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/dist"
touch "$tmp/dist/gameshelf-edge-test-linux-amd64.docker.tar.gz"

cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$COMMAND_LOG"
if [[ "$1 $2" == 'image inspect' ]]; then
  printf '%s\n' 'ghcr.io/shannonwetnight/gameshelf@sha256:example'
fi
EOF
cat > "$tmp/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
printf 'sha256sum %s\n' "$*" >> "$COMMAND_LOG"
EOF
cat > "$tmp/bin/python3" <<'EOF'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >> "$COMMAND_LOG"
EOF
chmod +x "$tmp/bin/"*

export PATH="$tmp/bin:$PATH"
export COMMAND_LOG="$tmp/commands.log"
export GITHUB_STEP_SUMMARY="$tmp/summary.md"
export GH_TOKEN=test-token GITHUB_ACTOR=tester CHANNEL=edge VERSION=edge-test
(cd "$tmp" && bash "$root/scripts/publish-edge.sh")

expected=$(cat <<'EOF'
sha256sum -c SHA256SUMS.txt
load -i dist/gameshelf-edge-test-linux-amd64.docker.tar.gz
python3 scripts/release.py guard
login ghcr.io --username tester --password-stdin
push ghcr.io/shannonwetnight/gameshelf:edge-test
image inspect --format {{index .RepoDigests 0}} ghcr.io/shannonwetnight/gameshelf:edge-test
python3 scripts/release.py guard
tag ghcr.io/shannonwetnight/gameshelf:edge-test ghcr.io/shannonwetnight/gameshelf:edge
push ghcr.io/shannonwetnight/gameshelf:edge
EOF
)
[[ "$(cat "$COMMAND_LOG")" == "$expected" ]]
grep -Fq 'No GitHub Release or Git tag was created.' "$GITHUB_STEP_SUMMARY"

# Stable requests must not take the Edge publishing path.
export CHANNEL=stable
if (cd "$tmp" && bash "$root/scripts/publish-edge.sh" >/dev/null 2>&1); then
  echo 'Stable request unexpectedly entered Edge publishing' >&2
  exit 1
fi

