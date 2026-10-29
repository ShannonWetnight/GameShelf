#!/usr/bin/env bash
# Publish a verified Edge container without creating a Git tag or GitHub Release.
set -euo pipefail

[[ "$CHANNEL" == edge ]]
(cd dist && sha256sum -c SHA256SUMS.txt)
docker load -i "dist/gameshelf-$VERSION-linux-amd64.docker.tar.gz"
python3 scripts/release.py guard

image="ghcr.io/shannonwetnight/gameshelf"
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
docker push "$image:$VERSION"
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image:$VERSION")
# Recheck branch freshness immediately before advancing the mutable Edge tag.
python3 scripts/release.py guard
docker tag "$image:$VERSION" "$image:edge"
docker push "$image:edge"

printf '\nEdge image: `%s:edge`\n\nVerified version: `%s`\n\nImage: `%s`\n\nThe test bundle is retained in the verification run\x27s artifacts. No GitHub Release or Git tag was created.\n' \
  "$image" "$VERSION" "$digest" >> "$GITHUB_STEP_SUMMARY"
if [[ -n "${VERIFIED_EDGE_RUN_ID:-}" ]]; then
  printf '\nVerification: https://github.com/%s/actions/runs/%s\n' "$GITHUB_REPOSITORY" "$VERIFIED_EDGE_RUN_ID" >> "$GITHUB_STEP_SUMMARY"
fi

