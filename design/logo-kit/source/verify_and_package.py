"""Validate the exported assets and write checksums. `--zip DIR` also writes a delivery ZIP there."""
from pathlib import Path
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parent.parent
checks = {}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assets():
    return sorted(p for p in ROOT.rglob('*') if p.is_file() and '__pycache__' not in p.parts
                  and p.name not in ('manifest.json', 'validation.json'))


svgs = list(ROOT.rglob('*.svg'))
for file in svgs:
    ET.parse(file)
for folder in ('master', 'symbols', 'wordmarks', 'lockups', 'web/svg'):
    for file in (ROOT / folder).glob('*.svg'):
        tree = ET.parse(file).getroot()
        assert not any(e.tag.split('}')[-1] in ('text', 'image') for e in tree.iter()), file
        assert 'http://' not in file.read_text(encoding='utf-8').replace('http://www.w3.org/2000/svg', ''), file
checks['svg_parse'] = len(svgs)
checks['flat_vectors_have_no_font_or_bitmap_dependencies'] = True

matches = {}
for frozen in (ROOT / 'source/approved-r6').glob('*.svg'):
    dest = ROOT / ('app/svg' if frozen.name.startswith('icon') else 'app/layers') / frozen.name
    assert sha(frozen) == sha(dest), dest
    matches[dest.relative_to(ROOT).as_posix()] = sha(dest)
checks['approved_R6_byte_identical'] = matches

jobs = json.loads((ROOT / 'source/export-jobs.json').read_text(encoding='utf-8'))
for job in jobs:
    with Image.open(ROOT / job['dest']) as im:
        assert im.width == job['width'], job
        # SVG export job may be rectangular, so compare actual source aspect.
        source = ET.parse(ROOT / job['src']).getroot()
        w, h = (float(source.get(k)) for k in ('width', 'height'))
        assert abs(im.height - job['width'] * h / w) <= 1, job
checks['flat_png_dimensions_checked'] = len(jobs)

app_sizes = (16,20,24,32,40,48,60,64,96,128,180,192,256,512,1024)
layer_results, comparisons = {}, {}
for theme in ('light', 'dark'):
    for size in app_sizes:
        with Image.open(ROOT / f'app/png/{theme}/icon-{size}.png') as im:
            assert im.size == (size, size), (theme, size)
            # Resampling a 24 px rounded corner can produce <=2/255 alpha ringing.
            assert im.convert('RGBA').getpixel((0,0))[3] <= 2, (theme, size)
    book = Image.open(ROOT / f'app/layers/png/layer1-{theme}-1024.png').convert('RGBA')
    probes = {}
    for name, x, y in [('lower-right',558,600),('lower-left',466,600),('center',512,430)]:
        alpha = max(book.getpixel((i,j))[3] for i in range(x-2,x+3) for j in range(y-2,y+3))
        assert alpha == 0, (theme, name, alpha)
        probes[name] = alpha
    layer_results[theme] = probes
    layers = [Image.open(ROOT / f'app/layers/png/layer{i}-{theme}-1024.png').convert('RGBA') for i in (0,1,2)]
    merged = Image.alpha_composite(Image.alpha_composite(layers[0],layers[1]),layers[2])
    reference = Image.open(ROOT / f'app/png/{theme}/icon-1024.png').convert('RGBA')
    stats = {}
    for bg_color in ('#FFFFFF', '#2B2747'):
        bg = Image.new('RGBA', reference.size, bg_color)
        diff = ImageChops.difference(Image.alpha_composite(bg,merged),Image.alpha_composite(bg,reference)).convert('RGB')
        mean = max(ImageStat.Stat(diff).mean)
        # Separate PNG compositing rounds alpha; isolated edge pixels may differ.
        # Mean error verifies alignment without falsely promising bit identity.
        assert mean < .5, (theme, bg_color, mean)
        stats[bg_color] = {'max_channel_mean_absolute_error':round(mean,4),
                           'max_channel_error':max(p[1] for p in diff.getextrema())}
    comparisons[theme] = stats
checks['app_png_dimensions_checked'] = 2 * len(app_sizes)
checks['layer_keyhole_alpha'] = layer_results
checks['layer_composite_against_full_R6'] = comparisons

for file, expected in [(ROOT / 'web/favicon.ico', {(16,16),(24,24),(32,32),(48,48),(64,64)})] + \
        [(ROOT / f'app/native/icon-{t}.ico', {(s,s) for s in (16,20,24,32,40,48,64,96,128,256)}) for t in ('light','dark')]:
    ico = Image.open(file)
    assert ico.ico.sizes() == expected, (file, ico.ico.sizes())
fav = Image.open(ROOT / 'web/favicon.ico').ico.getimage((16,16)).convert('RGBA')
expected_fav = Image.open(ROOT / 'web/png/icon-day-16.png').convert('RGBA')
assert ImageChops.difference(fav,expected_fav).getbbox() is None
for t, flat in (('light','day'), ('dark','night')):
    # Small native frames must be the hinted flat cuts, not downsampled glass.
    for size in (16, 24, 32):
        frame = Image.open(ROOT / f'app/native/icon-{t}.ico').ico.getimage((size,size)).convert('RGBA')
        assert ImageChops.difference(frame, Image.open(ROOT / f'web/png/icon-{flat}-{size}.png').convert('RGBA')).getbbox() is None, (t, size)
    with Image.open(ROOT / f'app/native/icon-{t}.icns') as im:
        im.load(); assert im.size == (1024,1024)
        assert {(16,16,1),(16,16,2),(32,32,1),(32,32,2),(512,512,2)} <= set(im.info['sizes']), im.info
checks['native_small_frames_are_flat_cuts'] = True
checks['native_containers_verified'] = ['favicon.ico', 'icon-light.ico', 'icon-dark.ico', 'icon-light.icns', 'icon-dark.icns']
checks['favicon_16_frame_is_exact_micro_asset'] = True

webmanifest = json.loads((ROOT / 'web/site.webmanifest').read_text())
for icon in webmanifest['icons']:
    assert (ROOT / 'web' / icon['src']).is_file(), icon
checks['web_manifest_paths_exist'] = True
pages = len(re.findall(rb'/Type\s*/Page[^s]', (ROOT / 'docs/usage-guide.pdf').read_bytes()))
assert pages == 1, pages
guide = (ROOT / 'docs/usage-guide.html').read_text(encoding='utf-8')
assert all(s in guide for s in ('Kinshoko', '留白', '小尺寸', 'R6'))
checks['usage_guide_pages'] = pages
checks['usage_guide_text_present'] = True

records = []
for file in assets():
    rec = dict(path=file.relative_to(ROOT).as_posix(), bytes=file.stat().st_size, sha256=sha(file))
    if file.suffix.lower() == '.png':
        with Image.open(file) as im: rec.update(width=im.width,height=im.height,mode=im.mode)
    records.append(rec)
manifest = dict(name='Kinshoko Logo Kit',version='1.1',approved_app='R6',files=records)
(ROOT / 'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
checks['asset_count'] = len(records)
(ROOT / 'docs/validation.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf-8')

summary = {'assets':len(records),'SVG':len(svgs),'flat_PNG':len(jobs),'glass_PNG':30,'PDF_pages':pages}
if '--zip' in sys.argv:
    archive = Path(sys.argv[sys.argv.index('--zip') + 1]).resolve() / 'kinshoko-logo-kit-v1.1.zip'
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as package:
        files = sorted(p for p in ROOT.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
        for file in files: package.write(file, 'kinshoko-logo-kit/' + file.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
    summary.update(ZIP=str(archive), ZIP_bytes=archive.stat().st_size)
print(json.dumps(summary, indent=2))
