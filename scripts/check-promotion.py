#!/usr/bin/env python3
"""Materialize a selective release candidate locally without GitHub mutations."""
import argparse
import importlib.util
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def materialize(public, output):
    promote = load('promotion', ROOT / '.github/scripts/promote.py')
    guard = load('public_guard', public / '.github/scripts/release.py')
    # Include working-tree changes for local regression checks. CI checks out exact commits.
    def files(root):
        paths = subprocess.check_output(['git', '-C', str(root), 'ls-files'], text=True).splitlines()
        return {p: {'path': p, 'type': 'blob', 'mode': '100644',
                    'sha': subprocess.check_output(['git', 'hash-object', str(root / p)], text=True).strip()}
                for p in paths if (root / p).is_file()}
    main, edge = files(public), files(ROOT)
    version = 'v999.0.0'  # Synthetic notes only; never used for publication.
    changes = promote.plan(main, edge, version, guard)
    paths = promote.candidate_paths(main, changes)
    promote.validate_build_inputs((ROOT / 'Dockerfile').read_text(), paths)
    guard.validate_public_paths(sorted(paths))
    if output.exists():
        raise ValueError('Candidate output must not exist: ' + str(output))
    output.mkdir(parents=True)
    for path in sorted(paths):
        source = ROOT if promote.production(path, guard) else public
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / path, target)
    return paths


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--main', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    materialize(args.main.resolve(), args.output.resolve())
