"""Native ICO/ICNS containers.

Frames shown at 32 px or less use the hinted flat cuts (glass detail turns to mush there,
see the usage guide); larger frames use the approved R6 glass renders. ICNS is written by
hand so its 16/32 pt slots can carry those dedicated small frames.
"""
from pathlib import Path
import io
import struct
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FLAT = {'light': 'day', 'dark': 'night'}
SMALL_MAX = 32


def png_bytes(path):
    with Image.open(path) as im:
        buf = io.BytesIO()
        im.convert('RGBA').save(buf, format='PNG', optimize=True)
        return buf.getvalue()


def ico(frames, out):
    """frames: [(size, png path)], PNG-compressed entries (Vista+)."""
    blobs = [(size, png_bytes(path)) for size, path in frames]
    header = struct.pack('<HHH', 0, 1, len(blobs))
    offset = len(header) + 16 * len(blobs)
    entries, data = b'', b''
    for size, blob in blobs:
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    out.write_bytes(header + entries + data)


def icns(entries, out):
    """entries: [(OSType, png path)]."""
    body = b''.join(kind.encode() + struct.pack('>I', 8 + len(blob)) + blob
                    for kind, blob in ((k, png_bytes(p)) for k, p in entries))
    out.write_bytes(b'icns' + struct.pack('>I', 8 + len(body)) + body)


def flat(theme, display, scale=1):
    if scale == 1:
        return ROOT / f'web/png/icon-{FLAT[theme]}-{display}.png'
    return ROOT / f'web/png/retina/icon-{FLAT[theme]}-{display}@{scale}x.png'


def app_frame(theme, size):
    return flat(theme, size) if size <= SMALL_MAX else ROOT / f'app/png/{theme}/icon-{size}.png'


def main():
    ico([(s, ROOT / f'web/png/icon-day-{s}.png') for s in (16, 24, 32, 48, 64)], ROOT / 'web/favicon.ico')
    folder = ROOT / 'app/native'
    folder.mkdir(parents=True, exist_ok=True)
    for theme in ('light', 'dark'):
        ico([(s, app_frame(theme, s)) for s in (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)], folder / f'icon-{theme}.ico')
        glass = lambda s: ROOT / f'app/png/{theme}/icon-{s}.png'
        icns([('icp4', flat(theme, 16)), ('ic11', flat(theme, 16, 2)),       # 16 pt @1x/@2x
              ('icp5', flat(theme, 32)), ('ic12', flat(theme, 32, 2)),       # 32 pt @1x/@2x
              ('ic07', glass(128)), ('ic13', glass(256)),                    # 128 pt
              ('ic08', glass(256)), ('ic14', glass(512)),                    # 256 pt
              ('ic09', glass(512)), ('ic10', glass(1024))],                  # 512 pt
             folder / f'icon-{theme}.icns')
    print('Created favicon.ico and light/dark app ICO + ICNS (flat <=32 px frames, R6 glass above).')


if __name__ == '__main__':
    main()
