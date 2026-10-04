"""SVG optical polish. Run from any directory; outputs stay beside this script."""
from pathlib import Path

OUT = Path(__file__).resolve().parent
OUTLINE = "M82 20 H174 A18 18 0 0 1 192 38 V236 L128 192 L64 236 V38 A18 18 0 0 1 82 20 Z"
KEYHOLE = "M116 117.8 A26 26 0 1 1 140 117.8 L147 158 H109 Z"
BOOK = OUTLINE + ' ' + KEYHOLE


def star(cx, cy, r, k=.16):
    d = r * k
    return (f"M{cx} {cy-r} C{cx+d} {cy-d} {cx+d} {cy-d} {cx+r} {cy} "
            f"C{cx+d} {cy+d} {cx+d} {cy+d} {cx} {cy+r} "
            f"C{cx-d} {cy+d} {cx-d} {cy+d} {cx-r} {cy} "
            f"C{cx-d} {cy-d} {cx-d} {cy-d} {cx} {cy-r} Z")


SPARK = star(716, 236, 104)
THEMES = {
    "light": dict(bg0="#FFFCF7", bg1="#F2EBE1", ambient="#DDD6EE", ambient_op=.12,
                  glow="#EDB6C4", glow_op=.18, body0="#5C507E", body1="#2E2747",
                  shadow="#38333E", shadow_op=.24, acc0="#FFD5DF", accm="#DF779C",
                  acc1="#A84975", refr=.08, sheen=.12, edge=.50,
                  pearl=("#FFE7D7", "#F4C5D4", "#C6C9E9", "#D7B8E6", "#EAB6CE")),
    "dark": dict(bg0="#29253F", bg1="#12111D", ambient="#9A91CF", ambient_op=.12,
                 glow="#CDBDDC", glow_op=.09, body0="#F7F5F5", body1="#D5D0DD",
                 shadow="#090712", shadow_op=.45, acc0="#FFE8A7", accm="#E5A442",
                 acc1="#B87530", refr=.06, sheen=.22, edge=.90,
                 pearl=("#FFF1CF", "#F5D7B5", "#E4CED5", "#CBC4E4", "#E5BFD0")),
}


def radial(name, color, opacity, cx, cy, radius, transform=""):
    return f'''<radialGradient id="{name}" gradientUnits="userSpaceOnUse" cx="{cx}" cy="{cy}" r="{radius}" gradientTransform="{transform}">
      <stop stop-color="{color}" stop-opacity="{opacity}"/>
      <stop offset=".38" stop-color="{color}" stop-opacity="{opacity*.62:.3f}"/>
      <stop offset=".72" stop-color="{color}" stop-opacity="{opacity*.18:.3f}"/>
      <stop offset="1" stop-color="{color}" stop-opacity="0"/>
    </radialGradient>'''


def star_rim():
    # Broad, low-opacity color grades into the body. Progressively narrower
    # strokes add a continuous pearl rim without an abrupt opaque inner boundary.
    # Everything is clipped by the star silhouette AFTER feathering.
    return ''.join(
        f'<path d="{SPARK}" fill="none" stroke="url(#star-spectrum)" '
        f'stroke-width="{width}" opacity="{opacity}" stroke-linejoin="round" '
        f'filter="url(#star-feather-{blur})"/>'
        for width, opacity, blur in [(32, .09, 'wide'), (22, .14, 'wide'),
                                     (14, .22, 'mid'), (8, .32, 'mid'), (3.5, .42, 'fine')]
    )


def icon(t, layers=(0, 1, 2), star_color=True):
    c = THEMES[t]
    defs = f'''<defs>
    <linearGradient id="bg" x2=".35" y2="1"><stop stop-color="{c['bg0']}"/><stop offset="1" stop-color="{c['bg1']}"/></linearGradient>
    {radial('ambient', c['ambient'], c['ambient_op'], 340, 280, 670)}
    {radial('glow', c['glow'], c['glow_op'], 580, 535, 470, 'translate(580 535) scale(1.06 .88) translate(-580 -535)')}
    <linearGradient id="body" x1="0" y1="0" x2=".6" y2="1"><stop stop-color="{c['body0']}" stop-opacity=".93"/><stop offset="1" stop-color="{c['body1']}" stop-opacity=".96"/></linearGradient>
    {radial('refract', c['glow'], c['refr'], 164, 145, 125)}
    <linearGradient id="sheen" x2=".2" y2="1"><stop stop-color="#fff" stop-opacity="{c['sheen']}"/><stop offset=".52" stop-color="#fff" stop-opacity=".03"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="depth" x1="64" y1="20" x2="175" y2="236" gradientUnits="userSpaceOnUse"><stop stop-color="#171124" stop-opacity="0"/><stop offset=".5" stop-color="#171124" stop-opacity="0"/><stop offset="1" stop-color="#171124" stop-opacity=".32"/></linearGradient>
    <linearGradient id="spec" x1="68" y1="22" x2="188" y2="226" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFF8F0" stop-opacity="{c['edge']}"/><stop offset=".26" stop-color="#F3F1FF" stop-opacity=".34"/>
      <stop offset=".50" stop-color="#FFF8F0" stop-opacity=".08"/><stop offset=".76" stop-color="#F4EEFF" stop-opacity=".14"/><stop offset="1" stop-color="#FFF6E9" stop-opacity=".54"/>
    </linearGradient>
    <!-- Local masks gate slightly displaced spectral strokes, under white highlights. -->
    {radial('edge-top', '#fff', 0 if t == 'light' else .85, 78, 32, 58)}
    {radial('edge-bottom', '#fff', .8, 139, 206, 61)}
    {radial('edge-hole', '#fff', .60, 111, 115, 29)}
    <mask id="dispersion" maskUnits="userSpaceOnUse" x="40" y="0" width="180" height="265" style="mask-type:luminance">
      <rect x="40" width="180" height="265" fill="#000"/>
      <rect x="40" width="180" height="265" fill="url(#edge-top)"/>
      <rect x="40" width="180" height="265" fill="url(#edge-bottom)"/>
      <rect x="40" width="180" height="265" fill="url(#edge-hole)"/>
    </mask>
    <linearGradient id="acc" x1=".15" y1="0" x2=".78" y2="1"><stop stop-color="{c['acc0']}"/><stop offset=".45" stop-color="{c['accm']}"/><stop offset="1" stop-color="{c['acc1']}"/></linearGradient>
    <linearGradient id="star-edge" x2=".75" y2="1"><stop stop-color="#FFFDF4" stop-opacity=".90"/><stop offset=".46" stop-color="#FFF5F1" stop-opacity=".15"/><stop offset="1" stop-color="#DAD6F2" stop-opacity=".28"/></linearGradient>
    {radial('star-sheen', '#fff', .42, 690, 200, 75)}
    <!-- A theme-related palette wraps the WHOLE star; no local mask gaps.
         Warm gold passes through peach/rose before lavender, avoiding cyan/green seams. -->
    <linearGradient id="star-spectrum" x1="639" y1="158" x2="783" y2="327" gradientUnits="userSpaceOnUse" color-interpolation="sRGB">
      <stop stop-color="{c['pearl'][0]}"/><stop offset=".27" stop-color="{c['pearl'][1]}"/>
      <stop offset=".52" stop-color="{c['pearl'][2]}"/><stop offset=".77" stop-color="{c['pearl'][3]}"/>
      <stop offset="1" stop-color="{c['pearl'][4]}"/>
    </linearGradient>
    <filter id="star-feather-wide" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3.2"/></filter>
    <filter id="star-feather-mid" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="star-feather-fine" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation=".65"/></filter>
    <clipPath id="tile"><rect width="1024" height="1024" rx="230"/></clipPath>
    <clipPath id="book"><path clip-rule="evenodd" d="{BOOK}"/></clipPath>
    <!-- Exclude the ORIGINAL keyhole after the shifted shadow has been blurred.
         A hole in the shadow's own path is not enough: displacement/blur fills it. -->
    <clipPath id="shadow-outside-hole" clipPathUnits="userSpaceOnUse"><path clip-rule="evenodd" d="M-256 -256 H512 V512 H-256 Z {KEYHOLE}" transform="translate(153.6 161.6) scale(2.8)"/></clipPath>
    <clipPath id="spark"><path d="{SPARK}"/></clipPath>
    <filter id="shadow" x="-60%" y="-50%" width="220%" height="220%"><feGaussianBlur stdDeviation="{4.5 if t == 'light' else 6.5}"/></filter>
    <filter id="star-shadow" x="-60%" y="-60%" width="220%" height="240%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="broad" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.6"/></filter>
    <filter id="spectral-soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation=".48"/></filter>
    </defs>'''
    parts = [defs, '<g clip-path="url(#tile)">']
    if 0 in layers:
        parts += ['<rect width="1024" height="1024" fill="url(#bg)"/>', '<rect width="1024" height="1024" fill="url(#ambient)"/>', '<rect width="1024" height="1024" fill="url(#glow)"/>']
    # A modest optical enlargement improves 32–64 px desktop recognition.
    # All foreground layers share the transform; their internal geometry stays intact.
    parts.append('<g transform="translate(-51.2 -48) scale(1.1)">')
    if 1 in layers:
        parts += [f'''<g clip-path="url(#shadow-outside-hole)"><path fill-rule="evenodd" d="{BOOK}" transform="translate({158 if t == 'light' else 153.6} {187.6 if t == 'light' else 180.6}) scale(2.8)" fill="{c['shadow']}" opacity="{c['shadow_op']}" filter="url(#shadow)"/></g>
        <g transform="translate(153.6 161.6) scale(2.8)">
          <path fill-rule="evenodd" d="{BOOK}" fill="url(#body)"/>
          <g clip-path="url(#book)">
            <rect x="40" y="10" width="180" height="250" fill="url(#refract)"/>
            <rect x="40" y="10" width="180" height="250" fill="url(#sheen)"/>
            <path d="{BOOK}" fill="none" stroke="url(#depth)" stroke-width="11" filter="url(#broad)"/>
            <path d="{BOOK}" fill="none" stroke="url(#spec)" stroke-width="{3 if t == 'light' else 5.5}" opacity="{.20 if t == 'light' else .40}" filter="url(#broad)"/>
            <g mask="url(#dispersion)" filter="url(#spectral-soft)">
              <path d="{BOOK}" transform="translate(1.05 .65)" fill="none" stroke="#AAD4E9" stroke-width="4.2" opacity=".78"/>
              <path d="{BOOK}" transform="translate(-.45 -.25)" fill="none" stroke="#F1B0BD" stroke-width="2.7" opacity=".63"/>
            </g>
            <path d="{BOOK}" fill="none" stroke="url(#spec)" stroke-width="{.95 if t == 'light' else 1.55}"/>
          </g>
        </g>''']
    if 2 in layers:
        parts += [f'''<path d="{SPARK}" transform="translate(-2 13)" fill="{c['shadow']}" opacity="{c['shadow_op']*.65:.3f}" filter="url(#star-shadow)"/>
          <path d="{SPARK}" fill="url(#acc)"/>
          <g clip-path="url(#spark)"><rect x="610" y="130" width="212" height="212" fill="url(#star-sheen)"/>
          {star_rim() if star_color else ''}
          <path d="{SPARK}" fill="none" stroke="url(#star-edge)" stroke-width="{1.2 if star_color else 3.4}" opacity="{.6 if star_color else 1}" stroke-linejoin="round"/></g>''']
    parts.append('</g></g>')
    if 0 in layers:
        parts.append(f'<rect x="1" y="1" width="1022" height="1022" rx="229" fill="none" stroke="#fff" stroke-opacity="{.40 if t == "light" else .10}" stroke-width="2"/>')
    return '\n'.join(parts)


def write_svg(name, content):
    (OUT / name).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n{content}\n</svg>\n', encoding='utf-8')


def board():
    panels = []
    for t, label in [('light', '日间 · 墨紫 × 玫瑰粉'), ('dark', '夜间 · 月白 × 琥珀金')]:
        sizes = ''.join(f'<figure><img src="icon-{t}.svg" width="{s}" height="{s}"><figcaption>{s} px</figcaption></figure>' for s in (128, 64, 32, 16))
        panels.append(f'''<section class="{t}"><h2>{label}</h2><div class="comparison">
        <figure><img src="original/icon-{t}.svg" width="260" height="260"><figcaption>上一版 R5</figcaption></figure>
        <figure><img src="icon-{t}.svg" width="260" height="260"><figcaption>连续珠光边缘 R6</figcaption></figure>
        </div><div class="sizes">{sizes}</div></section>''')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Kinshoko · Optical polish</title>
    <style>*{box-sizing:border-box}body{margin:0;padding:44px;background:#E9E5DE;color:#302B3C;font-family:"Segoe UI","Microsoft YaHei",sans-serif;width:1360px}
    h1{font-size:30px;margin:0 0 10px}p{font-size:16px;color:#79737F;margin:0 0 30px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
    section{border-radius:26px;padding:28px}section.light{background:#F8F5EF}section.dark{background:#171522;color:#F1EBDF}
    h2{font-weight:500;font-size:18px;margin:0 0 28px}figure{margin:0;text-align:center}figcaption{font-size:13px;opacity:.55;margin-top:12px}
    .comparison{display:flex;gap:24px}.sizes{display:flex;align-items:flex-end;gap:36px;margin-top:36px;padding-top:24px;border-top:1px solid #8882}
    img{display:block}footer{font-size:14px;color:#79737F;margin-top:22px}</style>
    <h1>Kinshoko · 连续珠光边缘</h1><p>完整边缘 / 主题关联色 / 向本体渐隐 · 修复投影进入锁孔</p><div class="grid">''' + ''.join(panels) + '</div><footer>SVG 原生矢量 · 下排为 R6 实际尺寸预览</footer></html>'


if __name__ == '__main__':
    for theme in THEMES:
        write_svg(f'icon-{theme}.svg', icon(theme))
        write_svg(f'icon-{theme}-neutral-star.svg', icon(theme, star_color=False))
        for layer in range(3):
            write_svg(f'layer{layer}-{theme}.svg', icon(theme, (layer,)))
    (OUT / 'board.html').write_text(board(), encoding='utf-8')
