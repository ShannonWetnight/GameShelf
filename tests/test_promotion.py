"""Selective release promotion must never copy the Edge harness into main."""
import importlib.util
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promote', Path(__file__).parents[1] / '.github/scripts/promote.py')
promote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promote)


def entry(path, sha='a' * 40):
    return {'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha}


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.note = '.github/release-notes/v2.2.0.md'
        self.main = {p: entry(p) for p in [*promote.REQUIRED, 'README.md', '.github/RELEASING.md',
                    '.github/scripts/release.py', '.github/scripts/publish.sh', '.github/workflows/edge.yml',
                    '.github/workflows/release.yml', 'web/app.js', 'web/old.png']}
        self.edge = {p: entry(p, 'b'*40) for p in [*promote.REQUIRED, self.note,
                    '.github/release-notes/v9.9.9.md', '.github/release-notes/edge.md',
                    'README.md', 'docs/RELEASING.md', 'scripts/release.py', 'scripts/docker-smoke.py',
                    'main_test.go', 'tests/example.py', '.github/actions/verify/action.yml',
                    '.github/scripts/promote.py', 'web/app.js', 'web/app.test.js', 'web/fixtures/test.png']}
        self.checked = []
        def validate(paths):
            self.checked.extend(paths)
            if 'tests/bad.py' in paths:
                raise ValueError('Polluted main')
        self.guard = SimpleNamespace(STABLE=re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+'),
                    is_public_path=lambda p: p not in {'web/app.test.js', 'web/fixtures/test.png'},
                    validate_public_paths=validate)

    def test_only_application_and_selected_notes_are_changed(self):
        changes = promote.plan(self.main, self.edge, 'v2.2.0', self.guard)
        expected = set(promote.REQUIRED) | {'web/app.js', 'web/old.png'}
        self.assertEqual({e['path'] for e in changes}, expected)
        self.assertEqual(next(e for e in changes if e['path']=='web/old.png')['sha'], None)
        self.assertIn('.github/scripts/release.py', self.checked)
        self.assertIn('README.md', self.checked)
        self.assertNotIn('scripts/release.py', self.checked)
        self.assertNotIn('web/app.test.js', self.checked)
        self.assertNotIn('.github/release-notes/edge.md', self.checked)
        self.assertIn(self.note, self.checked)

    def test_edge_does_not_need_stable_notes_but_requires_application_files(self):
        edge = {k:v for k,v in self.edge.items() if k!=self.note}
        self.assertEqual(promote.plan(self.main, edge, 'v2.2.0', self.guard),
                         promote.plan(self.main, self.edge, 'v2.2.0', self.guard))
        edge.pop('main.go')
        with self.assertRaises(ValueError):
            promote.plan(self.main, edge, 'v2.2.0', self.guard)

    def test_existing_version_notes_and_invalid_versions_are_rejected(self):
        with self.assertRaises(ValueError):
            promote.plan({**self.main,self.note:entry(self.note)}, self.edge, 'v2.2.0', self.guard)
        with self.assertRaises(ValueError):
            promote.plan(self.main, self.edge, '../notes', self.guard)

    def test_main_guard_checks_the_whole_candidate_tree(self):
        with self.assertRaisesRegex(ValueError, 'Polluted main'):
            promote.plan({**self.main,'tests/bad.py':entry('tests/bad.py')},self.edge,'v2.2.0',self.guard)

    def test_draft_notes_come_from_main_template(self):
        with TemporaryDirectory() as folder:
            public = Path(folder)
            template = public / '.github/release-notes/TEMPLATE.md'
            template.parent.mkdir(parents=True)
            template.write_text('## Changes\n\n- [Describe a change.]\n')
            with patch.object(promote, 'api', return_value={'sha': 'c' * 40}) as api:
                change = promote.draft_note_change(public, 'v2.2.0', 'ShannonWetnight/GameShelf')
            self.assertEqual(change, entry(self.note, 'c' * 40))
            api.assert_called_once_with('repos/ShannonWetnight/GameShelf/git/blobs',
                                        {'content': template.read_text(), 'encoding': 'utf-8'})
