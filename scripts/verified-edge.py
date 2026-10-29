#!/usr/bin/env python3
"""Select and download an exact, successful Edge push package; never rebuild it."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile

WORKFLOW = '.github/workflows/edge.yml'
IMAGE = 'ghcr.io/shannonwetnight/gameshelf'
SHA = re.compile(r'[0-9a-f]{40}')


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', '--method', 'GET', path], text=True))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def current_source(repo, source):
    require(bool(SHA.fullmatch(source)), 'Invalid source commit.')
    require(os.environ['GITHUB_REF'] == 'refs/heads/edge', 'Publish Edge from edge.')
    require(api(f'repos/{repo}/git/ref/heads/edge')['object']['sha'] == source,
            'Edge moved after this request. Start a new publication for the current commit.')


def validate_run(run, repo, source):
    require(run.get('repository', {}).get('full_name', '').lower() == repo.lower(), 'Wrong verification repository.')
    require(run.get('head_repository', {}).get('id') == run.get('repository', {}).get('id'), 'Fork verification is not publishable.')
    require(run.get('path') == WORKFLOW and run.get('event') == 'push'
            and run.get('head_branch') == 'edge' and run.get('head_sha') == source,
            'Only the exact Edge push verification can be published.')


def package(run, artifacts, source):
    suffix = f"-{run['id']}.{run['run_attempt']}-{source[:12]}"
    matches = [a for a in artifacts if not a.get('expired')
               and re.fullmatch(r'gameshelf-edge-[0-9]{8}' + re.escape(suffix), a.get('name', ''))]
    require(len(matches) == 1, 'No unique retained verification package. Rerun the Edge push verification first.')
    item = matches[0]
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', item.get('digest', '')) is not None, 'Package has no valid GitHub artifact digest.')
    return {'run_id': str(run['id']), 'attempt': str(run['run_attempt']),
            'artifact_id': str(item['id']), 'artifact_digest': item['digest'],
            'version': item['name'].removeprefix('gameshelf-')}


def select(repo, source, timeout=1800):
    current_source(repo, source)
    deadline = time.monotonic() + timeout
    announced = False
    while True:
        runs = api(f'repos/{repo}/actions/workflows/edge.yml/runs?event=push&head_sha={source}&per_page=100')['workflow_runs']
        require(bool(runs), 'No Edge push verification exists for this commit. Run it before publishing.')
        run = max(runs, key=lambda item: item['id'])
        validate_run(run, repo, source)
        if run['status'] == 'completed':
            require(run['conclusion'] == 'success', 'Edge verification did not pass. Fix or rerun it before publishing.')
            artifacts = api(f"repos/{repo}/actions/runs/{run['id']}/artifacts?per_page=100")['artifacts']
            return package(run, artifacts, source)
        require(time.monotonic() < deadline, 'Timed out waiting for Edge verification. No image was published.')
        if not announced:
            print(f"Waiting for existing verification run {run['id']}; no duplicate build will be started.", flush=True)
            announced = True
        time.sleep(15)
        current_source(repo, source)


def unpack(archive, destination, expected, source):
    require(not destination.exists() or not any(destination.iterdir()), 'Download destination must be empty.')
    version = expected['version']
    files = {'LICENSE', 'docker-compose.yml', 'release.json', 'RELEASE-NOTES.md', 'SHA256SUMS.txt',
             f'gameshelf-{version}-linux-amd64.docker.tar.gz', f'gameshelf-{version}-source.tar.gz',
             f'gameshelf-{version}-verification.tar.gz'}
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        require(len(entries) == len(files) and {e.filename for e in entries} == files,
                'Unexpected or duplicate files in the verified package.')
        require(sum(e.file_size for e in entries) <= 2 * 1024**3, 'Verification package is too large.')
        require(all(not e.is_dir() and not e.flag_bits & 1 and e.external_attr >> 16 & 0o170000 != 0o120000
                    for e in entries), 'Package links and encrypted entries are not allowed.')
        data = json.loads(bundle.read('release.json'))
        require(data.get('source_commit') == source and data.get('version') == version
                and data.get('channel') == 'edge' and data.get('platform') == 'linux/amd64'
                and data.get('image') == f'{IMAGE}:{version}', 'Package source, version, or image mismatch.')
        require(data.get('verification') == {'run_id': expected['run_id'], 'attempt': expected['attempt'],
                                           'event': 'push', 'ref': 'refs/heads/edge'}, 'Package verification provenance mismatch.')
        checksums = {}
        for line in bundle.read('SHA256SUMS.txt').decode().splitlines():
            match = re.fullmatch(r'([0-9a-f]{64})  (?:\./)?([^/\\]+)', line)
            require(match is not None and match[2] not in checksums, 'Invalid package checksum manifest.')
            checksums[match[2]] = match[1]
        require(set(checksums) == files - {'SHA256SUMS.txt'}, 'Package checksums do not cover every file.')
        with tempfile.TemporaryDirectory(prefix='gameshelf-verified-') as temporary:
            staged = Path(temporary)
            for name in files:
                digest = hashlib.sha256()
                with bundle.open(name) as incoming, (staged / name).open('wb') as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        digest.update(chunk)
                        outgoing.write(chunk)
                if name != 'SHA256SUMS.txt':
                    require(digest.hexdigest() == checksums[name], f'Checksum mismatch: {name}')
            destination.mkdir(exist_ok=True)
            # copyfile works even when the runner's temporary folder is on another filesystem.
            import shutil
            for name in files:
                shutil.copyfile(staged / name, destination / name)


def download(repo, source):
    current_source(repo, source)
    run_id, artifact_id = os.environ['VERIFIED_EDGE_RUN_ID'], os.environ['VERIFIED_EDGE_ARTIFACT_ID']
    require(run_id.isdigit() and artifact_id.isdigit(), 'Invalid verification identifiers.')
    run = api(f'repos/{repo}/actions/runs/{run_id}')
    validate_run(run, repo, source)
    require(run['status'] == 'completed' and run['conclusion'] == 'success', 'Verification is no longer successful.')
    selected = package(run, api(f'repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100')['artifacts'], source)
    require(selected['artifact_id'] == artifact_id and selected['version'] == os.environ['VERSION'], 'Verification package changed.')
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['gh', 'api', '--method', 'GET', f'repos/{repo}/actions/artifacts/{artifact_id}/zip'], stdout=archive, check=True)
        archive.seek(0)
        digest = hashlib.file_digest(archive, 'sha256').hexdigest()
        require('sha256:' + digest == selected['artifact_digest'], 'GitHub artifact digest mismatch.')
        archive.seek(0)
        unpack(archive, Path('dist'), selected, source)


if __name__ == '__main__':
    import sys
    try:
        repo, source = os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_SHA']
        if sys.argv[1] == 'select':
            selected = select(repo, source)
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                for key, value in selected.items():
                    output.write(f'{key}={value}\n')
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(f"Reusing verified Edge package from https://github.com/{repo}/actions/runs/{selected['run_id']}\n")
        elif sys.argv[1] == 'download':
            download(repo, source)
        else:
            raise ValueError('Choose select or download.')
    except (ValueError, KeyError, zipfile.BadZipFile) as error:
        raise SystemExit(str(error))
