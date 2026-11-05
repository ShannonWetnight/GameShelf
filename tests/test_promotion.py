"""Selective release promotion must never copy the Edge harness into main."""
import importlib.util
import re
import os
import subprocess
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


class ProductionContractTests(unittest.TestCase):
    def test_modular_application_is_selected(self):
        required = {'network.go', 'profiles.go', 'setup.go', 'restore.go',
                    'connectors/rclone/main.go', 'connectors/rclone/cat.go',
                    'connectors/rclone/go.mod', 'connectors/rclone/go.sum',
                    'connectors/rclone/notices/main.go', 'native/network-nfs.c'}
        for path in required:
            with self.subTest(path=path):
                self.assertTrue(promote.is_application_path(path))

    def test_development_and_unapproved_paths_are_excluded(self):
        for path in ('network_test.go', 'connectors/rclone/cat_test.go',
                     'connectors/rclone/servers.go', 'connectors/rclone/notices/main_test.go',
                     'connectors/rclone/fixtures/main.go', 'connectors/other/main.go',
                     'native/test.c', 'native/network-nfs-test.c', 'scripts/helper.go',
                     'web/test.js', 'web/foo.spec.js', 'images/fixtures/a.png',
                     '../main.go', 'web/../main.go', '/main.go', 'web//app.js'):
            with self.subTest(path=path):
                self.assertFalse(promote.is_application_path(path))

    def test_deleted_modules_and_connectors_are_removed(self):
        test = PromotionTests()
        test.setUp()
        deleted = {'obsolete.go', 'connectors/rclone/obsolete.go'}
        test.main.update({p: entry(p) for p in deleted})
        changes = promote.plan(test.main, test.edge, 'v2.2.0', test.guard)
        self.assertEqual({e['path'] for e in changes if e['sha'] is None}, deleted | {'web/old.png'})

    def test_missing_docker_inputs_fail_before_promotion(self):
        root = Path(__file__).parents[1]
        paths = {p.relative_to(root).as_posix() for p in root.rglob('*')
                 if p.is_file() and promote.is_application_path(p.relative_to(root).as_posix())}
        dockerfile = (root / 'Dockerfile').read_text()
        promote.validate_build_inputs(dockerfile, paths)
        for path in ('network.go', 'connectors/rclone/cat.go', 'connectors/rclone/go.sum',
                     'connectors/rclone/notices/main.go', 'native/network-nfs.c'):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'COPY input'):
                promote.validate_build_inputs(dockerfile, paths - {path})

    def test_symlink_or_submodule_sources_are_rejected(self):
        test = PromotionTests()
        test.setUp()
        for mode, kind in [('120000', 'blob'), ('160000', 'commit')]:
            test.edge['network.go'] = {**entry('network.go'), 'mode': mode, 'type': kind}
            with self.assertRaisesRegex(ValueError, 'regular file'):
                promote.plan(test.main, test.edge, 'v2.2.0', test.guard)


@unittest.skipUnless(Path(os.environ.get('PUBLIC_RELEASE_SCRIPT', '')).is_file(),
                     'Requires an existing main release guard checkout')
class ProjectedTreeTests(unittest.TestCase):
    def test_real_candidate_contains_all_production_sources_and_retains_main_tooling(self):
        root = Path(__file__).parents[1]
        public = Path(os.environ['PUBLIC_RELEASE_SCRIPT']).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('check_promotion', root / 'scripts/check-promotion.py')
        check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(check)
        with TemporaryDirectory() as folder:
            output = Path(folder) / 'candidate'
            paths = check.materialize(public, output)
            tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files'], text=True).splitlines()
            # Derive expected production files independently of the planner's selection.
            expected = {p for p in tracked if '/' not in p and p.endswith('.go') and not p.endswith('_test.go')}
            expected |= {'connectors/rclone/main.go', 'connectors/rclone/cat.go',
                         'connectors/rclone/go.mod', 'connectors/rclone/go.sum',
                         'connectors/rclone/notices/main.go', 'native/network-nfs.c'}
            self.assertTrue(expected <= paths, sorted(expected - paths))
            self.assertFalse(any(p.endswith('_test.go') or p.startswith(('tests/', 'scripts/', 'reports/')) for p in paths))
            self.assertNotIn('connectors/rclone/servers.go', paths)
            for path in ('README.md', 'ROADMAP.md', '.github/scripts/release.py', '.github/workflows/edge.yml'):
                self.assertEqual((output / path).read_bytes(), (public / path).read_bytes())
            guard = check.load('candidate_guard', output / '.github/scripts/release.py')
            guard.validate_public_paths(paths)
            for path in tracked:
                self.assertEqual(promote.is_application_path(path), guard.is_application_path(path), path)
