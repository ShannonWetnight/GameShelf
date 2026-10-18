#!/usr/bin/env python3
"""Create a selective main release PR after the Edge checks pass."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

CORE = {'Dockerfile', 'main.go', 'go.mod', 'go.sum', 'docker-compose.yml'}
REQUIRED = {'Dockerfile', 'main.go', 'go.mod', 'docker-compose.yml'}


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def entries(root):
    result = {}
    for line in git(root, 'ls-tree', '-r', 'HEAD').splitlines():
        metadata, path = line.split('\t')
        mode, kind, sha = metadata.split()
        result[path] = {'path': path, 'mode': mode, 'type': kind, 'sha': sha}
    return result


def production(path, guard):
    return (path in CORE or path.startswith(('web/', 'images/'))) and guard.is_public_path(path)


def plan(main, edge, version, guard):
    if not guard.STABLE.fullmatch(version):
        raise ValueError('Use a stable version such as v2.2.0.')
    if not REQUIRED.issubset(edge):
        raise ValueError('Edge is missing a required application file.')
    note = f'.github/release-notes/{version}.md'
    if note not in edge:
        raise ValueError(f'Commit {note} on Edge before promotion.')
    if note in main:
        raise ValueError('These version notes already exist on main; choose a new version.')
    selected = {path for path in edge if production(path, guard)} | {note}
    removed = {path for path in main if production(path, guard) and path not in edge}
    final_paths = (set(main) - removed) | selected
    guard.validate_public_paths(sorted(final_paths))
    changes = [edge[path] for path in sorted(selected) if main.get(path) != edge[path]]
    changes += [{**main[path], 'sha': None} for path in sorted(removed)]
    return changes


def api(path, payload):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as body:
        json.dump(payload, body)
        body.flush()
        data = subprocess.check_output(['gh', 'api', '--method', 'POST', path, '--input', body.name], text=True)
    return json.loads(data) if data.strip() else {}


def main():
    if os.environ['GITHUB_REF'] != 'refs/heads/edge':
        raise ValueError('Promotion must run from Edge.')
    edge, public = Path('tooling'), Path('public')
    spec = importlib.util.spec_from_file_location('main_release', public / '.github/scripts/release.py')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    if not hasattr(guard, 'validate_public_paths'):
        raise ValueError('Install the maintainer-folder cleanup on main before promotion.')
    version, source = os.environ['PROMOTE_VERSION'], os.environ['GITHUB_SHA']
    if git(edge, 'rev-parse', 'HEAD') != source:
        raise ValueError('Promotion source differs from the tested Edge commit.')
    changes = plan(entries(public), entries(edge), version, guard)
    guard.validate_notes(edge / f'.github/release-notes/{version}.md')
    repo = os.environ['GITHUB_REPOSITORY']
    base = git(public, 'rev-parse', 'HEAD')
    tree = api(f'repos/{repo}/git/trees', {'base_tree': git(public, 'rev-parse', 'HEAD^{tree}'), 'tree': changes})
    commit = api(f'repos/{repo}/git/commits', {'message': f'Prepare GameShelf {version} from Edge {source[:12]}',
                                             'tree': tree['sha'], 'parents': [base]})
    branch = f'release/{version}-{os.environ["GITHUB_RUN_ID"]}-{os.environ["GITHUB_RUN_ATTEMPT"]}'
    api(f'repos/{repo}/git/refs', {'ref': f'refs/heads/{branch}', 'sha': commit['sha']})
    paths = '\n'.join(f'- `{entry["path"]}`' for entry in changes)
    body = (f'Promote the application tested at Edge commit `{source}` for GameShelf {version}.\n\n'
            'This branch starts from main and copies approved application paths and the selected version notes only. '
            "Main's README, roadmap, workflows, and release helpers are retained. Tests, fixtures, Edge notes, "
            'and top-level docs/scripts are excluded.\n\nChanged paths:\n\n' + paths + '\n\n'
            f'Edge verification: https://github.com/{repo}/actions/runs/{os.environ["GITHUB_RUN_ID"]}\n\n'
            'Review this draft before merging. After merge, run the stable release Action from main with this version.')
    pr = api(f'repos/{repo}/pulls', {'title': f'Release {version}: promote tested application from Edge',
                                    'head': branch, 'base': 'main', 'draft': True, 'body': body})
    # Explicitly validate the automation-created PR without relying on PR events.
    # check_only skips all stable verification/publication jobs.
    api(f'repos/{repo}/actions/workflows/release.yml/dispatches',
        {'ref': branch, 'inputs': {'version': version, 'check_only': True}})
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'\nDraft release PR: {pr["html_url"]}\n\n{paths}\n')


if __name__ == '__main__':
    main()
