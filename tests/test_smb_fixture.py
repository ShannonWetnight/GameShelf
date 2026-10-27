"""Check the independent inventory used as the writable SMB test oracle."""
import importlib.util
import os
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('smb_fixture', pathlib.Path(__file__).with_name('smb-write-fixture') / 'fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class FixtureInventoryTests(unittest.TestCase):
    def test_detects_content_names_and_metadata_changes(self):
        mutations = {
            'same-size overwrite': lambda root: (root / 'game.bin').write_bytes(b'changed!'),
            'rename': lambda root: (root / 'game.bin').rename(root / 'renamed.bin'),
            'delete': lambda root: (root / 'game.bin').unlink(),
            'add hidden file': lambda root: (root / '.hidden').write_bytes(b'new'),
            'remove empty directory': lambda root: (root / 'empty').rmdir(),
            'permissions': lambda root: (root / 'game.bin').chmod(0o600),
            'modification timestamp': lambda root: os.utime(root / 'game.bin', ns=(1, 1)),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                (root / 'game.bin').write_bytes(b'original')
                (root / 'game.bin').chmod(0o644)
                (root / 'empty').mkdir()
                before = fixture.snapshot(root)
                self.assertEqual(before, fixture.snapshot(root), 'inventory itself changed relevant metadata')
                mutate(root)
                self.assertNotEqual(before, fixture.snapshot(root), name)

    def test_extended_attributes_are_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            file = root / 'game.bin'
            file.write_bytes(b'data')
            try:
                os.setxattr(file, 'user.fixture', b'first')
            except OSError as error:
                self.skipTest(f'xattrs unavailable: {error}')
            before = fixture.snapshot(root)
            self.assertEqual(before['game.bin']['xattrs']['user.fixture'], b'first'.hex())
            os.setxattr(file, 'user.fixture', b'second')
            self.assertNotEqual(before, fixture.snapshot(root))


if __name__ == '__main__':
    unittest.main()
