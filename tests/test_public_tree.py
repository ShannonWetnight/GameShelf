"""Exercise main's release guard without adding tests to main."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(os.environ.get('PUBLIC_RELEASE_SCRIPT', Path(__file__).parents[1] / 'scripts/release.py'))
if not path.exists():
    path = Path(__file__).parents[1] / 'scripts/release.py'
spec = importlib.util.spec_from_file_location('public_release', path)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
MARKER = '# Edge launcher only; test implementation lives on edge.'


@unittest.skipUnless(hasattr(release, 'check_tree'), 'Main-specific checks run against a main source checkout')
class PublicTreeTests(unittest.TestCase):
    def test_production_files_are_allowed(self):
        paths = 'main.go\nweb/app.js\nimages/gameshelf_icon.png\n.github/release-notes/v2.2.0.md\n.github/scripts/publish.sh'
        with patch.object(release, 'run', return_value=paths), patch.object(Path, 'read_text', return_value=MARKER):
            release.check_tree()

    def test_development_files_are_rejected(self):
        for path in ('main_test.go', 'tests/frontend.test.cjs', 'scripts/docker-smoke.py',
                     '.github/actions/verify/action.yml', '.github/release-notes/edge.md',
                     'web/app.test.js', 'web/fixtures/example.png', 'reports/scan.json', 'notes.txt', 'docs/RELEASING.md', 'scripts/release.py', 'scripts/publish.sh', '.github/scripts/promote.py'):
            with self.subTest(path=path), patch.object(release, 'run', return_value=path):
                with self.assertRaisesRegex(ValueError, 'Keep development files on edge'):
                    release.check_tree()

    def test_full_edge_workflow_is_rejected(self):
        with patch.object(release, 'run', return_value='main.go'), patch.object(Path, 'read_text', return_value='uses: ./.github/actions/verify'):
            with self.assertRaisesRegex(ValueError, 'launcher'):
                release.check_tree()

    def dispatch(self, result):
        def gh(*args):
            if args[:2] == ('api', '--method'):
                return ''
            if args[0] == 'api':
                return 'a' * 40
            return json.dumps([result])
        return gh

    def test_successful_edge_run_returns_its_exact_id(self):
        result = {'displayTitle': 'stable-123-1', 'headSha': 'a' * 40,
                  'status': 'completed', 'conclusion': 'success', 'databaseId': 456}
        with tempfile.TemporaryDirectory() as directory:
            env = dict(GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', GITHUB_REPOSITORY='owner/repo',
                       GITHUB_SHA='b'*40, VERSION='v2.2.0', GITHUB_OUTPUT=str(Path(directory)/'out'),
                       GITHUB_STEP_SUMMARY=str(Path(directory)/'summary'))
            with patch.dict(os.environ, env), patch.object(release, 'gh', side_effect=self.dispatch(result)):
                release.verify_on_edge()
            self.assertEqual(Path(env['GITHUB_OUTPUT']).read_text(), 'run_id=456\n')

    def test_failed_or_different_edge_run_is_rejected(self):
        for conclusion, sha in [('failure', 'a'*40), ('success', 'c'*40)]:
            result = {'displayTitle': 'stable-123-1', 'headSha': sha,
                      'status': 'completed', 'conclusion': conclusion, 'databaseId': 456}
            with patch.dict(os.environ, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1',
                            GITHUB_REPOSITORY='owner/repo', GITHUB_SHA='b'*40, VERSION='v2.2.0'), \
                 patch.object(release, 'gh', side_effect=self.dispatch(result)):
                with self.assertRaises(ValueError):
                    release.verify_on_edge()


class ReleasePresentationTests(unittest.TestCase):
    def test_header_matches_previous_releases(self):
        notes = '## Fixed\n\n- Preserve the library.\n\n## Security\n\n- Patch dependencies.'
        cover = '<img width="100" height="100" alt="gameshelf_icon" src="https://github.com/user-attachments/assets/8a218c22-cd59-497e-8f53-17e8eaaed681" />'
        for version in ('v2.2.0', 'edge-20261019-123.1-aaaaaaaaaaaa'):
            with self.subTest(version=version):
                expected = (f'{cover}\n\n## {version} Changes\n\n'
                            '### Fixed\n\n- Preserve the library.\n\n'
                            '### Security\n\n- Patch dependencies.\n')
                self.assertEqual(release.render_notes(version, notes), expected)
