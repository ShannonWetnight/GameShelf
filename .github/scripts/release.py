#!/usr/bin/env python3
"""Prepare release metadata and validate source/tag integrity."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

STABLE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
IMAGE = "ghcr.io/shannonwetnight/gameshelf"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def gh(*args):
    return run("gh", *args)


def check_tag(version, sha):
    lines = run("git", "ls-remote", "origin", f"refs/tags/{version}",
                f"refs/tags/{version}^{{}}").splitlines()
    if not lines:
        return False
    refs = dict(line.split()[::-1] for line in lines)
    actual = refs.get(f"refs/tags/{version}^{{}}", refs.get(f"refs/tags/{version}"))
    if actual != sha:
        raise ValueError(f"Tag {version} points to {actual}, but this package uses {sha}. "
                         "Choose a new version; existing tags must not move.")
    return True


def check_release(version):
    # Listing releases distinguishes a missing release from authentication/network
    # errors. Those errors must never be mistaken for permission to publish.
    tags = gh("api", f"repos/{os.environ['GITHUB_REPOSITORY']}/releases?per_page=100",
              "--paginate", "--jq", ".[].tag_name").splitlines()
    if version in tags:
        raise ValueError(f"Release {version} already exists. Use a new version.")


def validate_notes(path):
    if not path.is_file():
        raise ValueError(
            f"Release notes are missing: {path}. "
            "Create this file from .github/release-notes/TEMPLATE.md, add the version's changes, "
            "and commit it to the source branch. Then start a new workflow run; "
            "rerunning an older run keeps its original source commit."
        )
    text = path.read_text().strip()
    # Notes should describe changes; copying the template unchanged cannot pass.
    if re.search(r"\b(TODO|TBD)\b|\[PLACEHOLDER\]|\[Describe|\[Add ", text, re.I):
        raise ValueError(f"Replace unfinished placeholders in {path}.")
    if not re.search(r"^[-*] \S.+", text, re.M):
        raise ValueError(f"Add at least one change bullet to {path}.")
    sections = re.split(r"^##[ \t]+", text, flags=re.M)
    if sections[0].strip() or len(sections) == 1:
        raise ValueError(f"Use brief release-note sections in {path}: Changes, Fixed, Added, Other, Security.")
    seen = set()
    for section in sections[1:]:
        heading, _, content = section.partition("\n")
        if heading not in {"Changes", "Fixed", "Added", "Other", "Security"} or heading in seen:
            raise ValueError(f"Unsupported or repeated release-note section in {path}: {heading}.")
        seen.add(heading)
        if re.search(r"^#{1,6}[ \t]+", content, re.M) or not re.search(r"^[-*] \S.+", content, re.M):
            raise ValueError(f"Keep populated sections only in {path}; use brief bullets under {heading}.")
    return text


def render_notes(version, notes):
    cover = '<img width="100" height="100" alt="gameshelf_icon" src="https://github.com/user-attachments/assets/8a218c22-cd59-497e-8f53-17e8eaaed681" />'
    sections = re.sub(r"^## ", "### ", notes, flags=re.M)
    return f"{cover}\n\n## {version} Changes\n\n{sections}\n"


def prepare():
    channel = "stable"
    check_tree()
    ref = os.environ["GITHUB_REF"]
    sha = os.environ["GITHUB_SHA"]
    if run("git", "rev-parse", "HEAD") != sha:
        raise ValueError("Checked-out source does not match the workflow commit.")
    if channel == "stable":
        if ref != "refs/heads/main":
            raise ValueError("Run Publish stable release from main.")
        version = os.environ["VERSION"]
        if not STABLE.fullmatch(version):
            raise ValueError("Use a stable version such as v1.2.3.")
        notes = validate_notes(Path(f".github/release-notes/{version}.md"))
        check_tag(version, sha)
        check_release(version)
        # Stable tags remain valid release markers even if main's commit history
        # is rewritten. Select the highest earlier version across all tags.
        previous = next((tag for tag in run("git", "tag", "--list",
                        "--sort=-version:refname").splitlines()
                         if STABLE.fullmatch(tag) and tag != version), None)
        if previous and tuple(map(int, version[1:].split('.'))) <= tuple(map(int, previous[1:].split('.'))):
            raise ValueError(f"Choose a version newer than {previous}.")
    else:
        raise ValueError("Only stable releases belong on main.")

    body = render_notes(version, notes)
    Path("dist").mkdir(exist_ok=True)
    Path("dist/RELEASE-NOTES.md").write_text(body)
    metadata = {"version": version, "channel": channel, "source_commit": sha,
                "image": f"{IMAGE}:{version}", "platform": "linux/amd64", "previous_version": previous}
    Path("dist/release.json").write_text(json.dumps(metadata, indent=2) + "\n")
    with open(os.environ["GITHUB_ENV"], "a") as env:
        env.write(f"VERSION={version}\n")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"version={version}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(body)


def publication_guard():
    check_tree()
    data = json.loads(Path("dist/release.json").read_text())
    version, channel, sha = os.environ["VERSION"], os.environ["CHANNEL"], os.environ["GITHUB_SHA"]
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    require(data["source_commit"] == sha, "Package source mismatch")
    require(data["version"] == version and data["channel"] == channel, "Package version/channel mismatch")
    require(data["image"] == f"{IMAGE}:{version}", "Unexpected image name")
    require(data["image_id"] == run("docker", "image", "inspect", "--format", "{{.Id}}", data["image"]), "Loaded image differs from tested image")
    require(os.environ["GITHUB_REF"] == f"refs/heads/{'main' if channel == 'stable' else 'edge'}", "Wrong publication branch")
    if channel == 'stable':
        require(STABLE.fullmatch(version), "Invalid stable tag")
    else:
        raise ValueError("Main publishes stable releases only.")
    check_tag(version, sha)
    check_release(version)



def is_public_path(path):
    allowed = {
        'Dockerfile', 'LICENSE', 'README.md', 'ROADMAP.md', 'docker-compose.yml',
        'go.mod', 'go.sum', 'main.go', '.gitignore', '.github/RELEASING.md',
        '.github/workflows/edge.yml', '.github/workflows/release.yml',
        '.github/release-notes/TEMPLATE.md', '.github/scripts/release.py', '.github/scripts/publish.sh',
    }
    if path in allowed or re.fullmatch(r'\.github/release-notes/v[0-9]+\.[0-9]+\.[0-9]+\.md', path):
        return True
    return bool(path.startswith(('web/', 'images/'))
                and Path(path).suffix.lower() in {'.js', '.css', '.html', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.ico', '.woff', '.woff2'}
                and not re.search(r'(^|/)(tests?|fixtures?)(/|\.)|\.(test|spec)\.', path, re.I))


def validate_public_paths(paths):
    unexpected = [path for path in paths if not is_public_path(path)]
    if unexpected:
        raise ValueError('Keep development files on edge: ' + ', '.join(unexpected))


def check_tree():
    """Reject development files before they enter main or a public source release."""
    validate_public_paths(run('git', 'ls-tree', '-r', '--name-only', 'HEAD').splitlines())
    launcher = Path('.github/workflows/edge.yml').read_text()
    if '# Edge launcher only; test implementation lives on edge.' not in launcher or 'actions/verify' in launcher:
        raise ValueError('Main must retain the Edge launcher, not the Edge test workflow.')


def verify_on_edge():
    """Request an Edge-built package for this exact main commit and await it."""
    request = f"stable-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    repo, sha, version = os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_SHA'], os.environ['VERSION']
    edge_sha = gh('api', f'repos/{repo}/git/ref/heads/edge', '--jq', '.object.sha')
    gh('api', '--method', 'POST', f'repos/{repo}/actions/workflows/edge.yml/dispatches',
       '-f', 'ref=edge', '-f', f'inputs[source_sha]={sha}',
       '-f', f'inputs[stable_version]={version}', '-f', f'inputs[request_id]={request}',
       '-f', 'inputs[publish]=false')
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        runs = json.loads(gh('run', 'list', '--repo', repo, '--workflow', 'edge.yml',
                            '--branch', 'edge', '--event', 'workflow_dispatch', '--limit', '100',
                            '--json', 'databaseId,displayTitle,headSha,status,conclusion'))
        matches = [r for r in runs if r['displayTitle'] == request]
        if len(matches) > 1:
            raise ValueError('Multiple Edge runs matched this release request.')
        if matches:
            result = matches[0]
            if result['headSha'] != edge_sha:
                raise ValueError('Edge moved during dispatch. Retry to use one known test harness commit.')
            if result['status'] == 'completed':
                if result['conclusion'] != 'success':
                    raise ValueError(f"Edge verification failed: {result['databaseId']}")
                with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                    output.write(f"run_id={result['databaseId']}\n")
                with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                    summary.write(f"\nEdge verification: https://github.com/{repo}/actions/runs/{result['databaseId']}\n")
                return
        time.sleep(15)
    raise TimeoutError('Edge verification did not complete within 30 minutes.')


if __name__ == "__main__":
    try:
        {"prepare": prepare, "guard": publication_guard, "check-tree": check_tree, "verify-on-edge": verify_on_edge}[sys.argv[1]]()
    except ValueError as error:
        raise SystemExit(str(error))
