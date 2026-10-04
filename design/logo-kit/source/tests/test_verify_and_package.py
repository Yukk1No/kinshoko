"""Exercise the verifier CLI against real assets in disposable kit copies."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from PIL import Image

KIT = Path(__file__).resolve().parents[2]
ARCHIVE_NAME = 'kinshoko-logo-kit-v1.1.zip'
# Fail before an unfixed packager can read its own growing output indefinitely.
ZIP_SELF_GUARD = '''
from pathlib import Path
import runpy
import sys
import zipfile
original_write = zipfile.ZipFile.write
def guarded_write(package, filename, *args, **kwargs):
    if Path(filename).resolve() == Path(package.filename).resolve():
        raise AssertionError('ZIP must not include itself')
    return original_write(package, filename, *args, **kwargs)
zipfile.ZipFile.write = guarded_write
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
'''


class VerifyAndPackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='kinshoko-logo-tests-')
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.kit = self.workspace / 'logo-kit'
        shutil.copytree(KIT, self.kit, ignore=shutil.ignore_patterns('__pycache__', ARCHIVE_NAME))
        self.verifier = self.kit / 'source/verify_and_package.py'

    def run_verifier(self, *args, guard_zip=False):
        command = [sys.executable, '-B']
        if guard_zip:
            command += ['-c', ZIP_SELF_GUARD]
        command += [str(self.verifier), *args]
        return subprocess.run(command, cwd=self.kit, capture_output=True, text=True, timeout=30)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_unmodified_kit_passes(self):
        summary = self.assert_success(self.run_verifier())
        self.assertEqual(summary['PDF_pages'], 1)
        validation = json.loads((self.kit / 'docs/validation.json').read_text())
        self.assertTrue(validation['favicon_16_frame_is_exact_micro_asset'])
        self.assertTrue(validation['native_small_frames_are_flat_cuts'])

    def test_rgb_only_changes_to_favicon_and_small_native_frames_fail(self):
        cases = [('web/favicon.ico', 16)] + [
            (f'app/native/icon-{theme}.ico', size)
            for theme in ('light', 'dark') for size in (16, 20, 24, 32)]
        for relative, size in cases:
            with self.subTest(icon=relative, size=size):
                path = self.kit / relative
                original = path.read_bytes()
                try:
                    with Image.open(path) as container:
                        frames = [container.ico.getimage(dim).convert('RGBA')
                                  for dim in sorted(container.ico.sizes())]
                    frame = next(im for im in frames if im.size == (size, size))
                    alpha = frame.getchannel('A').tobytes()
                    xy = (size // 2, size // 2)
                    r, g, b, a = frame.getpixel(xy)
                    self.assertEqual(a, 255)
                    frame.putpixel(xy, (r ^ 255, g ^ 255, b ^ 255, a))
                    self.assertEqual(frame.getchannel('A').tobytes(), alpha)
                    frames[-1].save(path, format='ICO', sizes=[im.size for im in frames],
                                    append_images=frames[:-1])
                    result = self.run_verifier()
                    self.assertNotEqual(result.returncode, 0, 'Changed RGB was accepted as exact.')
                    self.assertIn('AssertionError', result.stderr)
                finally:
                    path.write_bytes(original)

    def assert_package_matches_manifest(self, archive):
        with zipfile.ZipFile(archive) as package:
            self.assertIsNone(package.testzip())
            names = package.namelist()
            self.assertEqual(len(names), len(set(names)))
            self.assertFalse(any(PurePosixPath(name).name.casefold() == ARCHIVE_NAME for name in names))
            prefix = 'kinshoko-logo-kit/'
            manifest = json.loads(package.read(prefix + 'manifest.json'))
            expected = {prefix + record['path'] for record in manifest['files']}
            self.assertEqual(set(names), expected | {prefix + 'manifest.json',
                                                     prefix + 'docs/validation.json'})
            for record in manifest['files']:
                data = package.read(prefix + record['path'])
                self.assertEqual(len(data), record['bytes'], record['path'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), record['sha256'], record['path'])
            validation = json.loads(package.read(prefix + 'docs/validation.json'))
            self.assertEqual(validation['asset_count'], len(manifest['files']))

    def test_repeated_zip_exports_inside_and_outside_the_kit(self):
        for output in ('.', 'exports', str(self.workspace / 'external')):
            (self.kit / output).mkdir(parents=True, exist_ok=True)
            archive = (self.kit / output) / ARCHIVE_NAME
            for run in range(2):
                with self.subTest(output=output, run=run):
                    self.assert_success(self.run_verifier('--zip', output, guard_zip=True))
                    self.assert_package_matches_manifest(archive)

    def test_previous_delivery_archives_are_not_assets_without_zip(self):
        for folder in (self.kit, self.kit / 'old-exports'):
            folder.mkdir(exist_ok=True)
            (folder / ARCHIVE_NAME).write_bytes(b'old delivery archive')
        self.assert_success(self.run_verifier())
        manifest = json.loads((self.kit / 'manifest.json').read_text())
        self.assertFalse(any(PurePosixPath(record['path']).name == ARCHIVE_NAME
                             for record in manifest['files']))

    def test_case_variant_delivery_archive_is_not_an_input(self):
        (self.kit / ARCHIVE_NAME.upper()).write_bytes(b'old delivery archive')
        self.assert_success(self.run_verifier('--zip', '.', guard_zip=True))
        self.assert_package_matches_manifest(self.kit / ARCHIVE_NAME)


if __name__ == '__main__':
    unittest.main()
