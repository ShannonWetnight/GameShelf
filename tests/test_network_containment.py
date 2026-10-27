import io
import pathlib
import runpy
import unittest
import zipfile


script = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / "scripts" / "network-containment.py"))


class StreamingZIPContainmentTests(unittest.TestCase):
    def test_exposure_is_detected_before_archive_finalization(self):
        # Streaming writers cannot seek back to fill the local header. The app
        # may abort after an entry but before writing a ZIP central directory.
        class StreamingBuffer(io.BytesIO):
            def seekable(self):
                return False

            def seek(self, *args):
                raise io.UnsupportedOperation("stream")

        output = StreamingBuffer()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("Game/unindexed.bin", script["OUTSIDE"])
            archive.writestr("Game/ordinary.bin", script["INSIDE"])
        data = output.getvalue()
        partial = data[:data.index(b"PK\x01\x02")]
        with self.assertRaises(zipfile.BadZipFile):
            zipfile.ZipFile(io.BytesIO(partial))
        contents = dict(script["zip_contents"](partial))
        self.assertEqual(contents["Game/unindexed.bin"], script["OUTSIDE"])
        self.assertEqual(contents["Game/ordinary.bin"], script["INSIDE"])

    def test_empty_and_short_responses_are_not_exposure(self):
        for data in [b"", b"PK\x03\x04", b"Could not read this network game"]:
            self.assertEqual(script["zip_contents"](data), [])

    def test_replacement_markers_preserve_indexed_lengths(self):
        self.assertEqual(len(script["INSIDE"]), len(script["OUTSIDE"]))
        self.assertEqual(len(script["INSIDE_ART"]), len(script["OUTSIDE_ART"]))


if __name__ == "__main__":
    unittest.main()
