"""Deterministic SVG assets. Python standard library; no font dependencies."""
from pathlib import Path
import importlib.util
import json
import shutil
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'source'
spec = importlib.util.spec_from_file_location('approved_app', SOURCE / 'build_app_r6.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
INK, CREAM, GOLD, SAKURA, PAPER = '#2B2747', '#F4ECDC', '#E3B34F', '#E0768F', '#F7F3EA'
PALETTE = dict(ink=INK, cream=CREAM, gold=GOLD, sakura=SAKURA, paper=PAPER, white='#FFFFFF', black='#000000')
THEMES = {'day': (PAPER, INK, SAKURA), 'night': (INK, CREAM, GOLD)}
SVGNS = '{http://www.w3.org/2000/svg}'
ref = ET.parse(SOURCE / 'reference/c-sparkle-k-lockup.svg').getroot()
letters = list(ref)[0]
wm_star = list(ref)[1].get('d')


def wordmark(fg, accent):
    parts = [f'<g fill="none" stroke="{fg}" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">']
    for element in letters:
        if element.tag == SVGNS + 'path':
            parts.append(f'<path d="{element.get("d")}"/>')
        elif element.tag == SVGNS + 'circle':
            cx, cy, r = (float(element.get(k)) for k in ('cx', 'cy', 'r'))
            parts.append(f'<path d="M{cx-r:g} {cy:g} A{r:g} {r:g} 0 1 0 {cx+r:g} {cy:g} A{r:g} {r:g} 0 1 0 {cx-r:g} {cy:g} Z"/>')
    parts.append(f'</g><path fill="{accent}" d="{wm_star}"/>')
    return ''.join(parts)


def mark(fg, path=None):
    return f'<path fill="{fg}" fill-rule="evenodd" d="{path or app.BOOK}"/>'


def horizontal(fg, accent):
    k = 178 / 216
    # Same paths, scale, baseline and inter-element spacing as combo-ac panels 3/4.
    return (f'<g transform="translate({22-64*k:.6f} -10)">'
            f'<g transform="translate(0 {33-20*k:.6f}) scale({k:.9f})">{mark(fg)}</g>'
            f'<g transform="translate(192 0)">{wordmark(fg, accent)}</g></g>')


def vertical(fg, accent):
    return f'<g transform="translate(271 2)">{mark(fg)}</g><g transform="translate(3 254)">{wordmark(fg, accent)}</g>'


def svg(body, width, height, title, viewbox=None):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="{viewbox or f"0 0 {width} {height}"}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')


def write(rel, content):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')


# Small-size cuts are hinted to the pixel grid of their DISPLAY size: outer edges,
# keyhole head and slot sit on whole pixels where possible (v1.1). The bookmark is
# centred on the tile like the 1024 app mark; the star overhangs the top-right corner.
MICRO = ('M5 2 H11 A1 1 0 0 1 12 3 V14 L8 11.5 L4 14 V3 A1 1 0 0 1 5 2 Z '
         'M7 7.73 A2 2 0 1 1 9 7.73 V10 H7 Z')
COMPACT = ('M8.5 4 H15.5 A1.5 1.5 0 0 1 17 5.5 V20 L12 17 L7 20 V5.5 A1.5 1.5 0 0 1 8.5 4 Z '
           'M11.2 11.83 A2 2 0 1 1 12.8 11.83 L13.5 14.5 H10.5 Z')
SMALL = ('M12 6 H20 A2 2 0 0 1 22 8 V27 L16 22.5 L10 27 V8 A2 2 0 0 1 12 6 Z '
         'M14.8 15.75 A3 3 0 1 1 17.2 15.75 L18 19.5 H14 Z')
# (size, tile radius, path, star (cx, cy, r, pinch) or None, knock-out halo width)
CUTS = {
    'micro': (16, 3.6, MICRO, None, 0),
    'compact': (24, 5.4, COMPACT, (17.4, 5.0, 3.3, .26), 1.1),
    'small': (32, 7.2, SMALL, (23.2, 6.6, 4.3, .24), 1.3),
}
H_WIDTH = 965 - 64 * (178 / 216) + 44


def flat_icon(theme, variant='standard', maskable=False):
    bg, fg, accent = THEMES[theme]
    if variant in CUTS:
        size, radius, path, star, halo = CUTS[variant]
        body = f'<rect width="{size}" height="{size}" rx="{radius}" fill="{bg}"/>{mark(fg, path)}'
        if star:
            d = app.star(*star)
            # Tile-coloured halo separates the star from the bookmark corner at small sizes.
            body += (f'<path d="{d}" fill="{bg}" stroke="{bg}" stroke-width="{halo*2}" stroke-linejoin="round"/>'
                     f'<path fill="{accent}" d="{d}"/>')
        return svg(body, size, size, f'Kinshoko {variant} {theme}')
    body = f'<rect width="1024" height="1024" rx="230" fill="{bg}"/>'
    body += f'<g transform="translate(-51.2 -48) scale(1.1)"><g transform="translate(153.6 161.6) scale(2.8)">{mark(fg)}</g><path fill="{accent}" d="{app.SPARK}"/></g>'
    if maskable:
        # Fully opaque square canvas; reduce to place the complete mark inside the
        # central 80% safe circle (verified from transformed path bounds).
        body = f'<rect width="1024" height="1024" fill="{bg}"/><g transform="translate(102.4 102.4) scale(.8)">{body}</g>'
    return svg(body, 1024, 1024, 'Kinshoko flat ' + theme)


def build():
    # Canonical path-based geometry, separate from the rendering treatment.
    write('master/bookmark.svg', svg(mark(INK), 256, 256, 'Kinshoko bookmark geometry'))
    write('master/wordmark.svg', svg(f'<g transform="translate(3 -10)">{wordmark(INK, SAKURA)}</g>', 798, 223, 'Kinshoko wordmark geometry'))
    write('master/app-mark.svg', svg(f'<g transform="translate(-51.2 -48) scale(1.1)"><g transform="translate(153.6 161.6) scale(2.8)">{mark(INK)}</g><path fill="{SAKURA}" d="{app.SPARK}"/></g>', 1024, 1024, 'Kinshoko app mark geometry'))
    for variant, (size, *_rest) in CUTS.items():
        write(f'master/bookmark-{variant}-{size}.svg', svg(mark(INK, CUTS[variant][2]), size, size, f'Kinshoko hinted {size} px geometry'))
    geometry = dict(version='1.1', app_version='R6', letter_stroke=22,
                    symbol=dict(viewBox=[0, 0, 256, 256], outer_bounds=[64, 20, 192, 236], path=app.BOOK),
                    wordmark=dict(bounds=[19, 32, 773, 211], i_star=wm_star),
                    horizontal=dict(width=H_WIDTH, height=223, symbol_scale=178/216, wordmark_x=192, padding=22),
                    vertical=dict(width=798, height=487, mark_to_wordmark_gap=48, padding=22),
                    clear_space='X = one wordmark stroke = 22 source units',
                    small_cuts={v: dict(size=c[0], tile_radius=c[1], path=c[2], star=c[3], halo=c[4]) for v, c in CUTS.items()},
                    palette=PALETTE)
    write('master/geometry.json', json.dumps(geometry, ensure_ascii=False, indent=2))
    for name, fg, accent in [('day', INK, SAKURA), ('night', CREAM, GOLD),
                            ('mono-ink', INK, INK), ('mono-black', '#000000', '#000000'),
                            ('reverse-white', '#FFFFFF', '#FFFFFF')]:
        for direction, body, w, h in [('horizontal', horizontal(fg, accent), H_WIDTH, 223),
                                      ('vertical', vertical(fg, accent), 798, 487)]:
            write(f'lockups/{direction}-{name}.svg', svg(body, round(w, 6), h, f'Kinshoko {direction} {name}'))
        write(f'wordmarks/wordmark-{name}.svg', svg(f'<g transform="translate(3 -10)">{wordmark(fg, accent)}</g>', 798, 223, 'Kinshoko wordmark ' + name))
        composite = f'<g transform="translate(-51.2 -48) scale(1.1)"><g transform="translate(153.6 161.6) scale(2.8)">{mark(fg)}</g><path fill="{accent}" d="{app.SPARK}"/></g>'
        write(f'symbols/app-mark-{name}.svg', svg(composite, 1024, 1024, 'Kinshoko app mark ' + name))
        for variant, path, canvas in [('standard', app.BOOK, 256)] + [(v, c[2], c[0]) for v, c in CUTS.items()]:
            write(f'symbols/bookmark-{variant}-{name}.svg', svg(mark(fg, path), canvas, canvas, 'Kinshoko symbol ' + name))
    for theme in THEMES:
        for variant in ('standard', *CUTS):
            write(f'web/svg/icon-{theme}-{variant}.svg', flat_icon(theme, variant))
        write(f'web/svg/icon-{theme}-maskable.svg', flat_icon(theme, maskable=True))
    # Theme-aware SVG favicon uses the optically enlarged micro geometry.
    fav = ('<style>:root{--tile:#F7F3EA;--mark:#2B2747}@media(prefers-color-scheme:dark){:root{--tile:#2B2747;--mark:#F4ECDC}}</style>'
           '<rect width="16" height="16" rx="3.6" style="fill:var(--tile)"/>'
           f'<path style="fill:var(--mark)" fill-rule="evenodd" d="{MICRO}"/>')
    write('web/favicon.svg', svg(fav, 16, 16, 'Kinshoko favicon'))
    webmanifest = dict(name='Kinshoko', short_name='Kinshoko', display='standalone',
                       background_color=PAPER, theme_color=INK,
                       icons=[dict(src=f'png/icon-day-{s}.png', sizes=f'{s}x{s}', type='image/png', purpose='any') for s in (192, 512)] +
                             [dict(src='png/icon-day-maskable-512.png', sizes='512x512', type='image/png', purpose='maskable')])
    write('web/site.webmanifest', json.dumps(webmanifest, indent=2))
    write('web/head-snippet.html', '''<!-- Place this web/ directory at /brand/ or update the paths to your asset location. -->
<link rel="icon" href="/brand/favicon.ico" sizes="any">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/brand/site.webmanifest">
<meta name="theme-color" content="#2B2747">
''')
    # The approved R6 SVGs are copied byte-for-byte, not regenerated/reinterpreted.
    for file in (SOURCE / 'approved-r6').glob('*.svg'):
        dest = ROOT / ('app/svg' if file.name.startswith('icon') else 'app/layers') / file.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, dest)
    jobs = []
    for category in ('lockups', 'wordmarks', 'symbols'):
        for file in sorted((ROOT / category).glob('*.svg')):
            width = 1600 if category in ('lockups', 'wordmarks') else next((c[0] for v, c in CUTS.items() if f'-{v}-' in file.stem), 512)
            jobs.append(dict(src=str(file.relative_to(ROOT)).replace('\\', '/'), dest=f'{category}/png/{file.stem}.png', width=width))
    for theme in THEMES:
        for size in (16, 20, 24, 32, 40, 48, 64, 96, 128, 180, 192, 256, 512, 1024):
            variant = 'micro' if size <= 20 else 'compact' if size <= 24 else 'small' if size <= 32 else 'standard'
            jobs.append(dict(src=f'web/svg/icon-{theme}-{variant}.svg', dest=f'web/png/icon-{theme}-{size}.png', width=size))
        # Retina exports retain the geometry selected by DISPLAY size, rather
        # than switching to a more detailed variant because pixel count grew.
        for base in (16, 20, 24, 32):
            variant = 'micro' if base <= 20 else 'compact' if base <= 24 else 'small'
            for scale in (2, 3):
                jobs.append(dict(src=f'web/svg/icon-{theme}-{variant}.svg',
                                 dest=f'web/png/retina/icon-{theme}-{base}@{scale}x.png', width=base*scale))
        jobs.append(dict(src=f'web/svg/icon-{theme}-maskable.svg', dest=f'web/png/icon-{theme}-maskable-512.png', width=512))
    write('source/export-jobs.json', json.dumps(jobs, indent=2))
    print(f'Generated geometry and SVG variants; {len(jobs)} flat raster exports queued.')


if __name__ == '__main__':
    build()
