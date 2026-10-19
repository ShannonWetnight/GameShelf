"""Exercise main's publication script with local command stubs."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


helper = Path(os.environ.get('PUBLIC_RELEASE_SCRIPT', 'missing'))
publisher = helper.with_name('publish.sh')


@unittest.skipUnless(helper.parent.name == 'scripts' and helper.parent.parent.name == '.github'
                     and publisher.is_file(), 'Requires a main source checkout')
class StablePublishTests(unittest.TestCase):
    def publish(self, fail_release=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'dist').mkdir()
            (root / '.github/scripts').mkdir(parents=True)
            notes = '## Fixed\n\n- Preserve the library after failed refreshes.\n'
            (root / 'dist/RELEASE-NOTES.md').write_text(notes)
            (root / 'dist/release.json').write_text(json.dumps({'source_commit': 'a' * 40}))
            (root / 'dist/gameshelf-v2.2.0-linux-amd64.docker.tar.gz').write_bytes(b'tested image')
            (root / 'dist/gameshelf-v2.2.0-source.tar.gz').write_bytes(b'pristine source')
            sums = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n'
                           for p in sorted((root / 'dist').iterdir()))
            (root / 'dist/SHA256SUMS.txt').write_text(sums)
            stub = '''#!/usr/bin/env python3
import json, os, pathlib, sys
command = pathlib.Path(sys.argv[0]).name
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps([command, *sys.argv[1:]]) + '\\n')
if command == 'docker' and sys.argv[1] == 'login':
    sys.stdin.read()
if command == 'docker' and sys.argv[1:3] == ['image', 'inspect']:
    print('ghcr.io/shannonwetnight/gameshelf@sha256:' + 'b' * 64)
if command == 'gh' and sys.argv[1:3] == ['release', 'create'] and os.environ['FAIL_RELEASE'] == '1':
    sys.exit(1)
'''
            for name in ('gh', 'docker'):
                path = root / 'bin' / name
                path.write_text(stub)
                path.chmod(0o755)
            (root / '.github/scripts/release.py').write_text(stub)
            env = dict(os.environ, PATH=str(root / 'bin') + os.pathsep + os.environ['PATH'],
                       VERSION='v2.2.0', CHANNEL='stable', GITHUB_REPOSITORY='owner/repo',
                       GITHUB_SHA='a' * 40, GH_TOKEN='local-test', GITHUB_ACTOR='tester',
                       GITHUB_STEP_SUMMARY=str(root / 'summary'), CALL_LOG=str(root / 'calls'),
                       FAIL_RELEASE=str(int(fail_release)))
            result = subprocess.run(['bash', str(publisher.resolve())], cwd=root, env=env,
                                    capture_output=True, text=True)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            self.assertEqual((root / 'dist/RELEASE-NOTES.md').read_text(), notes)
            self.assertEqual(json.loads((root / 'dist/release.json').read_text())['image_digest'],
                             'ghcr.io/shannonwetnight/gameshelf@sha256:' + 'b' * 64)
            if not fail_release:
                subprocess.run(['sha256sum', '-c', 'SHA256SUMS.txt'], cwd=root / 'dist',
                               check=True, capture_output=True)
                checked = [line.split('  ', 1)[1] for line in
                           (root / 'dist/SHA256SUMS.txt').read_text().splitlines()]
                self.assertEqual(checked, ['gameshelf-v2.2.0-linux-amd64.docker.tar.gz',
                                           'gameshelf-v2.2.0-source.tar.gz'])
            return result, calls

    def test_three_asset_release_keeps_verification_and_image_publication(self):
        result, calls = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(call for call in calls if call[:3] == ['gh', 'release', 'create'])
        self.assertEqual(create, ['gh', 'release', 'create', 'v2.2.0',
                                 'dist/gameshelf-v2.2.0-linux-amd64.docker.tar.gz',
                                 'dist/gameshelf-v2.2.0-source.tar.gz', 'dist/SHA256SUMS.txt',
                                 '--repo', 'owner/repo', '--verify-tag', '--target', 'a' * 40,
                                 '--title', 'GameShelf v2.2.0', '--notes-file',
                                 'dist/RELEASE-NOTES.md', '--draft', '--latest'])
        self.assertEqual(sum(call == ['release.py', 'guard'] for call in calls), 2)
        self.assertIn(['docker', 'push', 'ghcr.io/shannonwetnight/gameshelf:v2.2.0'], calls)
        edit = next(i for i, call in enumerate(calls) if call[:3] == ['gh', 'release', 'edit'])
        latest = calls.index(['docker', 'push', 'ghcr.io/shannonwetnight/gameshelf:latest'])
        self.assertLess(edit, latest)

    def test_failed_release_does_not_advance_latest(self):
        result, calls = self.publish(fail_release=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(['docker', 'push', 'ghcr.io/shannonwetnight/gameshelf:latest'], calls)
        self.assertFalse(any(call[:3] == ['gh', 'release', 'edit'] for call in calls))
