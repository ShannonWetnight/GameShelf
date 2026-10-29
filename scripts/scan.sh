#!/usr/bin/env bash
set -euo pipefail
scanner=ghcr.io/aquasecurity/trivy:0.76.1
targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then targets=(candidate builder); fi
for target in "${targets[@]}"; do [[ "$target" == candidate || "$target" == builder ]]; done
export SCAN_TARGETS="${targets[*]}"
mkdir -p reports
docker pull "$scanner"
docker image inspect "$scanner" > reports/scanner-image.json
blocked=0
for target in "${targets[@]}"; do
  # A scanner/database failure fails closed. The Python gate below also blocks
  # HIGH/CRITICAL findings without a published fix. Save all severities for review.
  if ! docker run --rm \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --mount "type=bind,src=$PWD/reports,dst=/reports" \
    --mount type=volume,src=gameshelf-trivy-cache,dst=/root/.cache/trivy \
    "$scanner" image --image-src docker --scanners vuln --detection-priority comprehensive \
    --format json --output "/reports/$target.json" "gameshelf:$target"; then
    blocked=1
  fi
done
python3 - <<'PY'
import collections, json, os, pathlib
blocked = False
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
    for target in os.environ['SCAN_TARGETS'].split():
        data = json.loads(pathlib.Path(f'reports/{target}.json').read_text())
        if pathlib.Path('network.go').exists():
            assert any(result.get('Type') == 'gobinary' and result.get('Target', '').endswith('/rclone')
                       for result in data.get('Results', [])), 'rclone embedded dependencies were not scanned'
        counts = collections.Counter(v['Severity'] for result in data.get('Results', [])
                                     for v in result.get('Vulnerabilities', []))
        summary.write(f'### {target} vulnerability scan\n\n{dict(counts)}\n\n')
        blocked |= bool(counts['HIGH'] or counts['CRITICAL'])
if blocked:
    raise SystemExit('HIGH/CRITICAL findings block publication; see verification artifact.')
PY
test "$blocked" -eq 0
