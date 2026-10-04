"""Raster exports with headless Chrome + Pillow (replaces export_kit.cjs; no Node packages).

Flat SVGs are rasterised by Chrome directly at their target size (several per screenshot,
then cropped), so small hinted cuts land on the pixel grid they were drawn for. The R6
glass icon is rasterised once at 1024 px and downsampled with Lanczos, as before.
Set CHROME_PATH if Chrome/Edge is not in a standard location.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CANDIDATES = [os.environ.get('CHROME_PATH', ''),
              r'C:\Program Files\Google\Chrome\Application\chrome.exe',
              r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              shutil.which('google-chrome') or '', shutil.which('chromium') or '']
SHEET_W, SHEET_H, GAP = 3400, 6000, 8


def chrome():
    for c in CANDIDATES:
        if c and Path(c).is_file():
            return c
    raise SystemExit('Chrome/Edge not found; set CHROME_PATH.')


def run_chrome(args, out, timeout=60):
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [chrome(), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
               '--no-default-browser-check', '--disable-extensions', '--force-device-scale-factor=1',
               f'--user-data-dir={Path(tmp) / "profile"}', *args]
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline, last = time.time() + timeout, -1
        while time.time() < deadline:
            if out.exists() and out.stat().st_size == last > 0:
                break
            last = out.stat().st_size if out.exists() else -1
            time.sleep(.3)
        proc.kill()
        proc.wait()
    if not out.exists():
        raise RuntimeError(f'Chrome produced no {out.name}')


def screenshot(html, out, w, h):
    out.unlink(missing_ok=True)
    run_chrome(['--default-background-color=00000000', f'--window-size={w},{h}',
                f'--screenshot={out}', html.as_uri()], out)


def print_pdf(html, out):
    out.unlink(missing_ok=True)
    run_chrome(['--no-pdf-header-footer', f'--print-to-pdf={out}', html.as_uri()], out)


def svg_height(src, width):
    root = ET.parse(src).getroot()
    w, h = (float(root.get(k)) for k in ('width', 'height'))
    return round(width * h / w)


def render_many(items):
    """items: [(src Path, dest Path, w, h)] -> exact-size transparent PNGs, few Chrome launches."""
    sheets, cur, x, y, row_h = [], [], 0, 0, 0
    for src, dest, w, h in sorted(items, key=lambda i: -i[3]):
        if x + w > SHEET_W:
            x, y, row_h = 0, y + row_h + GAP, 0
        if y + h > SHEET_H:
            sheets.append(cur)
            cur, x, y, row_h = [], 0, 0, 0
        cur.append((src, dest, w, h, x, y))
        x, row_h = x + w + GAP, max(row_h, h)
    if cur:
        sheets.append(cur)
    with tempfile.TemporaryDirectory() as tmp:
        for n, sheet in enumerate(sheets):
            width = max(i[4] + i[2] for i in sheet)
            height = max(i[5] + i[3] for i in sheet)
            tags = ''.join(f'<img src="{src.as_uri()}" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px">'
                           for src, _d, w, h, x, y in sheet)
            html = Path(tmp) / f'sheet{n}.html'
            html.write_text('<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}'
                            'img{position:absolute;display:block}</style></head><body>' + tags + '</body></html>',
                            encoding='utf-8')
            shot = Path(tmp) / f'sheet{n}.png'
            screenshot(html, shot, width, height)
            with Image.open(shot) as im:
                im = im.convert('RGBA')
                for _s, dest, w, h, x, y in sheet:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    im.crop((x, y, x + w, y + h)).save(dest, optimize=True)


def main():
    jobs = json.loads((ROOT / 'source/export-jobs.json').read_text(encoding='utf-8'))
    items = [(ROOT / j['src'], ROOT / j['dest'], j['width'], svg_height(ROOT / j['src'], j['width'])) for j in jobs]
    masters = {}
    for theme in ('light', 'dark'):
        masters[f'icon-{theme}'] = ROOT / f'app/svg/icon-{theme}.svg'
        for layer in (0, 1, 2):
            masters[f'layer{layer}-{theme}'] = ROOT / f'app/layers/layer{layer}-{theme}.svg'
    with tempfile.TemporaryDirectory() as tmp:
        big = {name: Path(tmp) / f'{name}.png' for name in masters}
        render_many(items + [(src, big[name], 1024, 1024) for name, src in masters.items()])
        for theme in ('light', 'dark'):
            with Image.open(big[f'icon-{theme}']) as master:
                for size in (16, 20, 24, 32, 40, 48, 60, 64, 96, 128, 180, 192, 256, 512, 1024):
                    dest = ROOT / f'app/png/{theme}/icon-{size}.png'
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    small = master.resize((size, size), Image.LANCZOS)
                    # Lanczos rings a few 1/255 steps of alpha outside the rounded tile; clear them.
                    small.putalpha(small.getchannel('A').point(lambda a: 0 if a < 4 else a))
                    small.save(dest, optimize=True)
            for layer in (0, 1, 2):
                with Image.open(big[f'layer{layer}-{theme}']) as png:
                    for size in (512, 1024):
                        dest = ROOT / f'app/layers/png/layer{layer}-{theme}-{size}.png'
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        png.resize((size, size), Image.LANCZOS).save(dest, optimize=True)
    shutil.copyfile(ROOT / 'web/png/icon-day-180.png', ROOT / 'web/apple-touch-icon.png')
    print(f'Exported {len(jobs)} flat PNGs, 30 glass app PNGs and 12 layer PNGs.')


if __name__ == '__main__':
    main()
