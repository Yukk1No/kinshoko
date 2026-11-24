"""Download the UI fonts confirmed in #28 into .local/fonts and check them.

Inter 4.1 static hinted 400 / 500 / 600 and the full Source Han Sans SC VF 2.005R, unmodified official
files (docs/research/font-rendering-and-selection.md). They stay out of git like the samples; the dev
server serves them at /fonts and the build copies them next to dist/index.html.
"""

import hashlib
import io
import urllib.request
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / ".local" / "fonts"
INTER_ZIP = "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip"
HAN = "https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R"

FILES = {
    "Inter-Regular.woff2": "338239f6b590b8ced3bf857654d32da3fd3663294cd3003651ed57aa3abd7aa1",
    "Inter-Medium.woff2": "7e80d9f65861ee6836a0081d4e75d88fb8789e5651d05edbc49640442a9610ee",
    "Inter-SemiBold.woff2": "5013f48d77ab627b1db7c2415914284ef09abc3f60a8e0d0d8f3cd1bfebefb5e",
    "SourceHanSansSC-VF.ttf.woff2": "cfec773cdc2ea964de8713471c6fd20774bc40617f5567f92efeeccaca6604b0",
}


def get(url):
    with urllib.request.urlopen(url) as r:
        return r.read()


def ok(name):
    path = OUT / name
    return path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == FILES[name]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if not all(ok(n) for n in FILES if n.startswith("Inter")):
        with zipfile.ZipFile(io.BytesIO(get(INTER_ZIP))) as z:
            for name in FILES:
                if name.startswith("Inter"):
                    (OUT / name).write_bytes(z.read(f"extras/woff-hinted/{name}"))
            (OUT / "LICENSE-Inter.txt").write_bytes(z.read("LICENSE.txt"))
    if not ok("SourceHanSansSC-VF.ttf.woff2"):
        (OUT / "SourceHanSansSC-VF.ttf.woff2").write_bytes(get(f"{HAN}/Variable/WOFF2/TTF/SourceHanSansSC-VF.ttf.woff2"))
        (OUT / "LICENSE-SourceHanSans.txt").write_bytes(get(f"{HAN}/LICENSE.txt"))
    bad = [n for n in FILES if not ok(n)]
    if bad:
        raise SystemExit(f"SHA-256 mismatch: {', '.join(bad)}")
    print(f"{len(FILES)} font files OK in {OUT}")


if __name__ == "__main__":
    main()
