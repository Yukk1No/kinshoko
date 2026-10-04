# Rejected glass app icon (v4). Reproduces icon-light.svg / icon-dark.svg byte-for-byte:
#   python build.py
from pathlib import Path
BODY = ("M90 20 H166 A26 26 0 0 1 192 46 V226 Q192 238 182 231 L128 194 L74 231 Q64 238 64 226 V46 A26 26 0 0 1 90 20 Z "
        "M116 117.8 A26 26 0 1 1 140 117.8 L147 158 H109 Z")
def star(cx, cy, r, k=0.16):
    d = r*k
    return (f"M{cx} {cy-r} C{cx+d} {cy-d} {cx+d} {cy-d} {cx+r} {cy} C{cx+d} {cy+d} {cx+d} {cy+d} {cx} {cy+r} "
            f"C{cx-d} {cy+d} {cx-d} {cy+d} {cx-r} {cy} C{cx-d} {cy-d} {cx-d} {cy-d} {cx} {cy-r} Z")
STAR = star(188, 46, 44, 0.2)

MODES = {
 "light": dict(bg0="#FFF9F0", bg1="#F1E4D6", glowA="#F7B7C8", glowB="#C9C0F2",
               b0="#8F84E0", b1="#4A3F96", bshadow="#4A3F96",
               s0="#FFC2D1", s1="#E0688A", sshadow="#E0688A", inner="#E0688A"),
 "dark":  dict(bg0="#35305C", bg1="#151326", glowA="#7A5CE0", glowB="#4F6BD8",
               b0="#C4B8FF", b1="#6D5DD3", bshadow="#000000",
               s0="#FFE39A", s1="#E39A2C", sshadow="#E39A2C", inner="#FF7FAE"),
}

def glass(id_, d, c0, c1, shadow, sh_op, ev=True, inner=None):
    fr = 'fill-rule="evenodd"' if ev else ''
    return f'''
  <defs>
    <linearGradient id="{id_}-fill" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="{c0}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="{c1}" stop-opacity="0.92"/>
    </linearGradient>
    <linearGradient id="{id_}-rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.95"/>
      <stop offset="0.35" stop-color="#fff" stop-opacity="0.15"/>
      <stop offset="0.65" stop-color="#fff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.6"/>
    </linearGradient>
    <radialGradient id="{id_}-caustic" cx="0.5" cy="1.0" r="0.6">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="{id_}-spec" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="{id_}-clip"><path {fr} d="{d}"/></clipPath>
  </defs>
  <path {fr} d="{d}" fill="{shadow}" opacity="{sh_op}" filter="url(#soft)" transform="translate(0 10)"/>
  <path {fr} d="{d}" fill="url(#{id_}-fill)"/>
  <g clip-path="url(#{id_}-clip)">
    <rect x="0" y="120" width="256" height="140" fill="url(#{id_}-caustic)"/>
    <ellipse cx="100" cy="22" rx="80" ry="26" fill="url(#{id_}-spec)" filter="url(#hair)"/>
    {f'<ellipse cx="170" cy="215" rx="70" ry="60" fill="{inner}" opacity="0.55" filter="url(#soft)"/>' if inner else ''}
    <path {fr} d="{d}" fill="none" stroke="#fff" stroke-opacity="0.28" stroke-width="10" filter="url(#hair)"/>
    <path {fr} d="{d}" fill="none" stroke="url(#{id_}-rim)" stroke-width="3.2"/>
    
  </g>'''

def icon(mode):
    m = MODES[mode]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="{m['bg0']}"/><stop offset="1" stop-color="{m['bg1']}"/>
    </linearGradient>
    <radialGradient id="gA" cx="0.18" cy="0.12" r="0.7"><stop offset="0" stop-color="{m['glowB']}" stop-opacity="0.55"/><stop offset="1" stop-color="{m['glowB']}" stop-opacity="0"/></radialGradient>
    <radialGradient id="gB" cx="0.9" cy="0.95" r="0.7"><stop offset="0" stop-color="{m['glowA']}" stop-opacity="0.55"/><stop offset="1" stop-color="{m['glowA']}" stop-opacity="0"/></radialGradient>
    <linearGradient id="tileRim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0.18"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="hair" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="tiny" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter>
    <clipPath id="tile"><rect width="1024" height="1024" rx="230"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <rect width="1024" height="1024" fill="url(#gA)"/>
    <rect width="1024" height="1024" fill="url(#gB)"/>
    <g transform="translate(150 182) scale(2.6)">

      {glass("bm", BODY, m['b0'], m['b1'], m['bshadow'], 0.30, inner=m['inner'])}
      {glass("st", STAR, m['s0'], m['s1'], m['sshadow'], 0.35, ev=False)}
    </g>
    <rect x="3" y="3" width="1018" height="1018" rx="227" fill="none" stroke="url(#tileRim)" stroke-width="6"/>
  </g>
</svg>'''

for mode in MODES:
    (Path(__file__).parent / f"icon-{mode}.svg").write_text(icon(mode), encoding="utf-8", newline="")
