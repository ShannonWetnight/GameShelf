"""Release failure cases; no credentials, registry, or Docker daemon required."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = 'a' * 40


class ReleaseTests(unittest.TestCase):
    def test_reused_edge_package_rejects_missing_provenance_stale_branch_and_wrong_image(self):
        version = 'edge-20261029-123.2-' + SHA[:12]
        metadata = {'source_commit': SHA, 'version': version, 'channel': 'edge',
                    'image': release.IMAGE + ':' + version, 'image_id': 'sha256:' + 'c'*64,
                    'verification': {'run_id': '123', 'attempt': '2', 'event': 'push', 'ref': 'refs/heads/edge'}}
        env = dict(GITHUB_REPOSITORY='owner/repo', GITHUB_SHA=SHA, GITHUB_REF='refs/heads/edge',
                   VERSION=version, CHANNEL='edge', VERIFIED_EDGE_RUN_ID='123')
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                Path('dist').mkdir()
                for changes, current, image, expected in [({}, SHA, metadata['image_id'], None),
                        ({'verification': {}}, SHA, metadata['image_id'], 'provenance'),
                        ({}, 'b'*40, metadata['image_id'], 'Edge moved'), ({}, SHA, 'other image', 'differs')]:
                    Path('dist/release.json').write_text(json.dumps({**metadata, **changes}))
                    with self.subTest(expected=expected), patch.dict(os.environ, env), \
                            patch.object(release, 'run', return_value=image), patch.object(release, 'gh', return_value=current), \
                            patch.object(release, 'check_tag'), patch.object(release, 'check_release'):
                        if expected:
                            with self.assertRaisesRegex(ValueError, expected):
                                release.publication_guard()
                        else:
                            release.publication_guard()
            finally:
                os.chdir(previous)

    def test_moved_tag_is_rejected(self):
        with patch.object(release, 'run', return_value=f"{'b' * 40}\trefs/tags/v1.2.3"):
            with self.assertRaisesRegex(ValueError, 'must not move'):
                release.check_tag('v1.2.3', SHA)

    def test_annotated_tag_uses_peeled_commit(self):
        output = f"{'b' * 40}\trefs/tags/v1.2.3\n{SHA}\trefs/tags/v1.2.3^{{}}"
        with patch.object(release, 'run', return_value=output):
            self.assertTrue(release.check_tag('v1.2.3', SHA))

    def test_missing_tag_can_be_created(self):
        with patch.object(release, 'run', return_value=''):
            self.assertFalse(release.check_tag('v1.2.3', SHA))

    def test_existing_release_is_rejected(self):
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), patch.object(release, 'gh', return_value='v1.2.3'):
            with self.assertRaisesRegex(ValueError, 'already exists'):
                release.check_release('v1.2.3')

    def test_api_failure_is_not_missing_release(self):
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), patch.object(release, 'gh', side_effect=RuntimeError('API failed')):
            with self.assertRaisesRegex(RuntimeError, 'API failed'):
                release.check_release('v1.2.3')

    def test_missing_notes_explain_how_to_start_a_new_run(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'v2.1.2.md'
            with self.assertRaisesRegex(ValueError, 'Then start a new workflow run') as caught:
                release.validate_notes(path)
            self.assertIn(str(path), str(caught.exception))
            self.assertIn('original source commit', str(caught.exception))

    def test_empty_or_template_notes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'notes.md'
            for text in ('', '# Changes', '- TODO: changes', '- [PLACEHOLDER]', '- [Describe a change.]'):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    release.validate_notes(path)
            path.write_text('## Changes\n\n- Preserve the library when a refresh fails.\n')
            self.assertIn('Preserve', release.validate_notes(path))
            path.write_text('## Fixed\n\n- Fix placeholder cover scaling.\n')
            self.assertIn('placeholder cover', release.validate_notes(path))

    def test_release_note_sections_stay_audience_facing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'notes.md'
            for heading in ('Changes', 'Fixed', 'Added', 'Other', 'Security'):
                path.write_text(f'## {heading}\n\n- Brief release item.\n')
                self.assertIn(heading, release.validate_notes(path))
            for text in ('## Limitations\n\n- Unsupported.\n',
                         '## Build and installation\n\n- Docker details.\n',
                         '## Included commits\n\n- Commit log.\n',
                         '## Fixed\n\n- Fix refresh.\n\n## Other\n',
                         '## Fixed\n\n- Fix refresh.\n\n## Fixed\n\n- Duplicate.\n',
                         '## Fixed\n\n- Fix refresh.\n\n### Build details\n'):
                path.write_text(text)
                with self.subTest(text=text), self.assertRaises(ValueError):
                    release.validate_notes(path)

    def test_stable_versions_reject_shell_and_path_input(self):
        for value in ('v1.2.3; echo bad', '../notes', 'v01.2.3', 'v1.2.3-beta', 'v1.2.3\n'):
            self.assertIsNone(release.STABLE.fullmatch(value))

    def test_wrong_branch_is_rejected_before_build(self):
        for channel, ref in (('stable', 'refs/heads/edge'), ('edge', 'refs/heads/main')):
            with patch.dict(os.environ, CHANNEL=channel, GITHUB_REF=ref, GITHUB_SHA=SHA,
                            GITHUB_EVENT_NAME='workflow_dispatch'), patch.object(release, 'run', return_value=SHA):
                with self.assertRaises(ValueError):
                    release.prepare()

    def test_checkout_must_match_workflow_source(self):
        with patch.dict(os.environ, CHANNEL='stable', GITHUB_REF='refs/heads/main', GITHUB_SHA=SHA), patch.object(release, 'run', return_value='b' * 40):
            with self.assertRaisesRegex(ValueError, 'workflow commit'):
                release.prepare()

    def test_edge_notes_are_brief_and_metadata_keeps_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            os.chdir(directory)
            try:
                Path('.github/release-notes').mkdir(parents=True)
                Path('.github/release-notes/edge.md').write_text('## Fixed\n\n- Fix refresh failures.\n')
                def git(*args):
                    if args[1] == 'rev-parse':
                        return SHA
                    if args[1] == 'tag':
                        return 'edge-previous'
                    raise AssertionError(f'Unexpected Git command: {args}')
                with patch.dict(os.environ, CHANNEL='edge', GITHUB_REF='refs/heads/edge', GITHUB_SHA=SHA,
                                GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='2',
                                GITHUB_REPOSITORY='owner/repo', GITHUB_ENV='env', GITHUB_OUTPUT='output',
                                GITHUB_STEP_SUMMARY='summary'), patch.object(release, 'run', side_effect=git):
                    release.prepare()
                metadata = json.loads(Path('dist/release.json').read_text())
                self.assertEqual(metadata['source_commit'], SHA)
                self.assertIn('-123.2-aaaaaaaaaaaa', metadata['version'])
                self.assertEqual(metadata['previous_version'], 'edge-previous')
                self.assertEqual(Path('dist/RELEASE-NOTES.md').read_text(), release.render_notes(metadata['version'], '## Fixed\n\n- Fix refresh failures.'))
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
