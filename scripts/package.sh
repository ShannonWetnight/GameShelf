#!/usr/bin/env bash
set -euo pipefail
image="ghcr.io/shannonwetnight/gameshelf:$VERSION"
# Re-tag and export the already-tested image. Do not rebuild for publication.
docker tag gameshelf:candidate "$image"
docker save "$image" | gzip > "dist/gameshelf-$VERSION-linux-amd64.docker.tar.gz"
git archive --format=tar.gz --prefix="gameshelf-$VERSION/" "$GITHUB_SHA" \
  > "dist/gameshelf-$VERSION-source.tar.gz"
cp LICENSE dist/LICENSE
tar -czf "dist/gameshelf-$VERSION-verification.tar.gz" reports
python3 - <<'PY'
import json, os, pathlib, subprocess
path = pathlib.Path('dist/release.json')
data = json.loads(path.read_text())
data['image_id'] = subprocess.check_output(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', data['image']], text=True).strip()
path.write_text(json.dumps(data, indent=2) + '\n')
pathlib.Path('dist/docker-compose.yml').write_text('''services:
  gameshelf:
    image: ''' + data['image'] + '''
    ports:
      - "8080:8080"
    environment:
      GAMESHELF_ROOT: /games
    volumes:
      - /path/to/your/library:/games:ro
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
''')
PY
(cd dist && find . -type f ! -name SHA256SUMS.txt -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt)
