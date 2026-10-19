#!/usr/bin/env bash
set -euo pipefail
(cd dist && sha256sum -c SHA256SUMS.txt)
docker load -i "dist/gameshelf-$VERSION-linux-amd64.docker.tar.gz"
python3 .github/scripts/release.py guard
repo="$GITHUB_REPOSITORY"
image="ghcr.io/shannonwetnight/gameshelf"
ref="tags/$VERSION"
# The API creates only a missing tag, without updating an existing reference.
# Listing refs first avoids treating permission or network errors as a 404.
existing=$(gh api "repos/$repo/git/matching-refs/$ref" --jq ".[] | select(.ref == \"refs/$ref\") | .object.sha")
if [[ -z "$existing" ]]; then
  gh api --method POST "repos/$repo/git/refs" -f "ref=refs/$ref" -f "sha=$GITHUB_SHA" > /dev/null
fi
# Re-check after creation and before publishing. check_tag peels annotated tags.
python3 .github/scripts/release.py guard
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
docker push "$image:$VERSION"
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image:$VERSION")
IMAGE_DIGEST="$digest" python3 - <<'PYMETA'
import json, os
from pathlib import Path
path = Path('dist/release.json')
data = json.loads(path.read_text())
data['image_digest'] = os.environ['IMAGE_DIGEST']
path.write_text(json.dumps(data, indent=2) + '\n')
PYMETA
# Keep provenance in metadata, outside the audience-facing release notes.
# Publish only the two verified archives and a checksum for those archives.
docker_archive="gameshelf-$VERSION-linux-amd64.docker.tar.gz"
source_archive="gameshelf-$VERSION-source.tar.gz"
(cd dist && sha256sum "$docker_archive" "$source_archive" > SHA256SUMS.txt && sha256sum -c SHA256SUMS.txt)
flags=(--latest)
alias=latest
gh release create "$VERSION" "dist/$docker_archive" "dist/$source_archive" dist/SHA256SUMS.txt \
  --repo "$repo" --verify-tag --target "$GITHUB_SHA" --title "GameShelf $VERSION" \
  --notes-file dist/RELEASE-NOTES.md --draft "${flags[@]}"
gh release edit "$VERSION" --repo "$repo" --draft=false "${flags[@]}"
# Advance the channel alias only after the versioned release is public.
docker tag "$image:$VERSION" "$image:$alias"
docker push "$image:$alias"
printf '\nRelease: https://github.com/%s/releases/tag/%s\n\nImage: `%s`\n' \
  "$repo" "$VERSION" "$digest" >> "$GITHUB_STEP_SUMMARY"
