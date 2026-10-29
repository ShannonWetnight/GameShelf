"""Artifact reuse must fail closed before publication or extraction."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('verified_edge', Path(__file__).parents[1] / 'scripts/verified-edge.py')
verified = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verified)
SOURCE = 'a' * 40
REPO = 'owner/repo'
RUN = {'id': 123, 'run_attempt': 2, 'repository': {'full_name': REPO, 'id': 4},
       'head_repository': {'id': 4}, 'event': 'push', 'path': verified.WORKFLOW,
       'head_branch': 'edge', 'head_sha': SOURCE, 'status': 'completed', 'conclusion': 'success'}
VERSION = 'edge-20261029-123.2-' + SOURCE[:12]
ARTIFACT = {'id': 456, 'name': 'gameshelf-' + VERSION, 'expired': False, 'digest': 'sha256:' + 'b' * 64}
EXPECTED = verified.package(RUN, [ARTIFACT], SOURCE)


def archive(change=None, extra=None):
    metadata = {'version': VERSION, 'channel': 'edge', 'source_commit': SOURCE, 'platform': 'linux/amd64',
                'image': verified.IMAGE + ':' + VERSION, 'image_id': 'sha256:' + 'c' * 64,
                'verification': {'run_id': '123', 'attempt': '2', 'event': 'push', 'ref': 'refs/heads/edge'}}
    if change:
        metadata.update(change)
    files = {'LICENSE': b'license', 'docker-compose.yml': b'compose', 'release.json': json.dumps(metadata).encode(),
             'RELEASE-NOTES.md': b'notes', f'gameshelf-{VERSION}-linux-amd64.docker.tar.gz': b'verified image',
             f'gameshelf-{VERSION}-source.tar.gz': b'pristine source', f'gameshelf-{VERSION}-verification.tar.gz': b'reports'}
    files['SHA256SUMS.txt'] = ''.join(f'{hashlib.sha256(data).hexdigest()}  ./{name}\n' for name, data in files.items()).encode()
    files.update(extra or {})
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as bundle:
        for name, data in files.items():
            bundle.writestr(name, data)
    result.seek(0)
    return result


class VerifiedEdgeTests(unittest.TestCase):
    def test_provenance_rejects_prs_forks_wrong_workflows_and_commits(self):
        verified.validate_run(RUN, REPO, SOURCE)
        for changes in ({'event': 'pull_request'}, {'event': 'workflow_dispatch'}, {'head_sha': 'c'*40},
                        {'path': '.github/workflows/release.yml'}, {'head_branch': 'main'},
                        {'head_repository': {'id': 5}}, {'repository': {'id': 4, 'full_name': 'other/repo'}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                verified.validate_run({**RUN, **changes}, REPO, SOURCE)

    def test_package_rejects_expired_duplicate_old_attempt_and_missing_digest(self):
        self.assertEqual(EXPECTED['run_id'], '123')
        for artifacts in ([], [{**ARTIFACT, 'expired': True}], [ARTIFACT, ARTIFACT],
                          [{**ARTIFACT, 'name': ARTIFACT['name'].replace('123.2', '123.1')}],
                          [{**ARTIFACT, 'digest': ''}]):
            with self.subTest(artifacts=artifacts), self.assertRaises(ValueError):
                verified.package(RUN, artifacts, SOURCE)

    def test_select_waits_for_existing_run_without_starting_another(self):
        records = [{'workflow_runs': [{**RUN, 'status': 'in_progress', 'conclusion': None}]},
                   {'workflow_runs': [RUN]}, {'artifacts': [ARTIFACT]}]
        with patch.object(verified, 'current_source'), patch.object(verified, 'api', side_effect=records) as api, \
                patch.object(verified.time, 'sleep') as sleep:
            self.assertEqual(verified.select(REPO, SOURCE), EXPECTED)
            sleep.assert_called_once_with(15)
            self.assertEqual(len(api.call_args_list), 3)

    def test_failed_or_missing_verification_never_falls_back_to_another_build(self):
        for response in ({'workflow_runs': []}, {'workflow_runs': [{**RUN, 'conclusion': 'failure'}]}):
            with patch.object(verified, 'current_source'), patch.object(verified, 'api', return_value=response), self.assertRaises(ValueError):
                verified.select(REPO, SOURCE)

    def test_changed_edge_is_rejected(self):
        with patch.dict(os.environ, GITHUB_REF='refs/heads/edge'), \
                patch.object(verified, 'api', return_value={'object': {'sha': 'c'*40}}), self.assertRaisesRegex(ValueError, 'Edge moved'):
            verified.current_source(REPO, SOURCE)

    def test_unpack_verifies_all_files_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'dist'
            verified.unpack(archive(), destination, EXPECTED, SOURCE)
            self.assertEqual((destination / f'gameshelf-{VERSION}-linux-amd64.docker.tar.gz').read_bytes(), b'verified image')
            with self.assertRaisesRegex(ValueError, 'empty'):
                verified.unpack(archive(), destination, EXPECTED, SOURCE)

    def test_metadata_tampering_traversal_and_bad_checksums_leave_no_package(self):
        cases = [archive(change={'source_commit': 'c'*40}), archive(change={'verification': {}}),
                 archive(change={'image': 'other/image:tag'}), archive(extra={'../escape': b'bad'}),
                 archive(extra={'SHA256SUMS.txt': b'0'*64 + b'  LICENSE\n'}),
                 archive(extra={f'gameshelf-{VERSION}-source.tar.gz': b'modified'})]
        for bundle in cases:
            with self.subTest(bundle=bundle), tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / 'dist'
                with self.assertRaises(ValueError):
                    verified.unpack(bundle, destination, EXPECTED, SOURCE)
                self.assertFalse(destination.exists())

    def test_download_checks_github_digest_before_extraction(self):
        env = {'VERIFIED_EDGE_RUN_ID': '123', 'VERIFIED_EDGE_ARTIFACT_ID': '456', 'VERSION': VERSION}
        def download(*args, **kwargs):
            kwargs['stdout'].write(b'tampered zip')
        with patch.dict(os.environ, env), patch.object(verified, 'current_source'), \
                patch.object(verified, 'api', side_effect=[RUN, {'artifacts': [ARTIFACT]}]), \
                patch.object(verified.subprocess, 'run', side_effect=download), patch.object(verified, 'unpack') as unpack:
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                verified.download(REPO, SOURCE)
            unpack.assert_not_called()

    def test_download_revalidates_run_and_extracts_the_matching_digest(self):
        payload = archive().getvalue()
        artifact = {**ARTIFACT, 'digest': 'sha256:' + hashlib.sha256(payload).hexdigest()}
        env = {'VERIFIED_EDGE_RUN_ID': '123', 'VERIFIED_EDGE_ARTIFACT_ID': '456', 'VERSION': VERSION}
        def download(*args, **kwargs):
            kwargs['stdout'].write(payload)
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                with patch.dict(os.environ, env), patch.object(verified, 'current_source'), \
                        patch.object(verified, 'api', side_effect=[RUN, {'artifacts': [artifact]}]), \
                        patch.object(verified.subprocess, 'run', side_effect=download):
                    verified.download(REPO, SOURCE)
                self.assertEqual(json.loads(Path('dist/release.json').read_text())['source_commit'], SOURCE)
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
