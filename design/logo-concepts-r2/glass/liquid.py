# Liquid-glass app icon study: sparkle layer behind a frosted keyhole-bookmark glass layer.
import re, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
BM = re.search(r'd="(.*?)"', open("../a-keyhole.svg",encoding="utf-8").read(), re.S).group(1)
BM = " ".join(BM.split())
K = 2.963; T = 512 - 128*K           # symbol 256-space -> 1024 icon, centred
KX, KY = 512, T + 94.7*K             # keyhole circle centre in icon space

def star(cx, cy, r, k=0.16):
    d = r*k
    return (f"M{cx} {cy-r} C{cx+d} {cy-d} {cx+d} {cy-d} {cx+r} {cy} C{cx+d} {cy+d} {cx+d} {cy+d} {cx} {cy+r} "
            f"C{cx-d} {cy+d} {cx-d} {cy+d} {cx-r} {cy} C{cx-d} {cy-d} {cx-d} {cy-d} {cx} {cy-r} Z")

THEMES = {
 "light": dict(bg0="#FFF8F2", bg1="#EFD6DD", glow="#FFFFFF", st0="#F7A3B6", st1="#D9587A",
               frost0=0.50, frost1=0.16, rim=1.0, shadow="#7A3A52", shop=0.28, tint="#FFFFFF"),
 "dark":  dict(bg0="#3E3968", bg1="#16142A", glow="#5A538E", st0="#FFE29A", st1="#D99A2B",
               frost0=0.26, frost1=0.07, rim=0.75, shadow="#000000", shop=0.45, tint="#E9E4FF"),
}

def icon(name, t, uid):
    CY = T + 128*K*0.0 + 470 - T  # keyhole centroid
    S = star(KX, 470, 300, 0.30)
    S += " " + f"M{KX+118} 470 A118 118 0 1 1 {KX-118} 470 A118 118 0 1 1 {KX+118} 470 Z"
    bm = f'<path d="{BM}" fill-rule="evenodd" transform="translate({T:.1f} {T:.1f}) scale({K})"/>'
    bm_shape = f'<path d="{BM}" fill-rule="evenodd" transform="translate({T:.1f} {T:.1f}) scale({K})"'
    tile = f'<rect width="1024" height="1024" rx="228" fill="url(#bg{uid})"/><rect width="1024" height="1024" rx="228" fill="url(#gl{uid})"/>'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
 <linearGradient id="bg{uid}" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="{t['bg0']}"/><stop offset="1" stop-color="{t['bg1']}"/></linearGradient>
 <radialGradient id="gl{uid}" cx="0.5" cy="0.38" r="0.6"><stop offset="0" stop-color="{t['glow']}" stop-opacity="0.55"/><stop offset="1" stop-color="{t['glow']}" stop-opacity="0"/></radialGradient>
 <linearGradient id="st{uid}" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="{t['st0']}"/><stop offset="1" stop-color="{t['st1']}"/></linearGradient>
 <linearGradient id="fr{uid}" x1="0.1" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="{t['tint']}" stop-opacity="{t['frost0']}"/><stop offset="1" stop-color="{t['tint']}" stop-opacity="{t['frost1']}"/></linearGradient>
 <linearGradient id="rim{uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="{t['rim']}"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.08"/><stop offset="0.7" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#fff" stop-opacity="{t['rim']*0.6}"/></linearGradient>
 <radialGradient id="spec{uid}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
 <clipPath id="tc{uid}"><rect width="1024" height="1024" rx="228"/></clipPath>
 <clipPath id="bc{uid}">{bm.replace(' fill-rule="evenodd"',' clip-rule="evenodd"')}</clipPath>
 <filter id="blur{uid}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="26"/></filter>
 <filter id="sh{uid}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
 <filter id="glow{uid}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>
<g clip-path="url(#tc{uid})">
 {tile}
 <!-- back layer: sparkle with soft glow -->
 <path d="{S}" fill="url(#st{uid})" opacity="0.55" filter="url(#glow{uid})"/>
 <path d="{S}" fill="url(#st{uid})"/>
 <!-- glass shadow -->
 <g opacity="{t['shop']}" filter="url(#sh{uid})" transform="translate(0 26)">{bm_shape} fill="{t['shadow']}"/></g>
 <!-- glass body: re-draw backdrop blurred inside the bookmark, then frost -->
 <g clip-path="url(#bc{uid})">
  {tile}
  <path d="{S}" fill="url(#st{uid})" filter="url(#blur{uid})" transform="translate(0 10)"/>
  <rect width="1024" height="1024" fill="url(#fr{uid})"/>
  <ellipse cx="300" cy="250" rx="150" ry="70" fill="url(#spec{uid})" opacity="0.55" transform="rotate(-32 300 250)"/>
 </g>
 <!-- rim light -->
 <path d="{BM}" fill="none" stroke="url(#rim{uid})" stroke-width="{7/K:.2f}" stroke-linejoin="round" transform="translate({T:.1f} {T:.1f}) scale({K})"/>
 <!-- tile edge highlight -->
 <rect x="3" y="3" width="1018" height="1018" rx="225" fill="none" stroke="#fff" stroke-opacity="{0.5 if name=='light' else 0.14}" stroke-width="4"/>
</g>
</svg>'''

for name, t in THEMES.items():
    open(f"icon-{name}.svg","w",encoding="utf-8").write(icon(name, t, name))

# board: both icons large + on wallpapers at real-ish sizes
def embed(name, x, y, size):
    body = open(f"icon-{name}.svg",encoding="utf-8").read()
    inner = body.split('\n',1)[1].rsplit('</svg>',1)[0].replace('id="', f'id="{x}_{y}').replace('url(#', f'url(#{x}_{y}')
    return f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="0 0 1024 1024">{inner}</svg>'
W,H = 1600, 1000
o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
 '<defs><linearGradient id="wl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F6E7EC"/><stop offset="0.5" stop-color="#EDEFF7"/><stop offset="1" stop-color="#F7EEDC"/></linearGradient>'
 '<linearGradient id="wd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1B1930"/><stop offset="0.6" stop-color="#2C2550"/><stop offset="1" stop-color="#4A2D45"/></linearGradient></defs>',
 f'<rect width="800" height="{H}" fill="url(#wl)"/><rect x="800" width="800" height="{H}" fill="url(#wd)"/>',
 '<text x="60" y="80" font-family="Segoe UI,sans-serif" font-weight="700" font-size="34" fill="#2B2747">Light · 纸白 × 墨紫 × 樱粉</text>',
 '<text x="860" y="80" font-family="Segoe UI,sans-serif" font-weight="700" font-size="34" fill="#F4ECDC">Dark · 墨紫 × 奶油 × 金</text>',
 embed("light", 160, 140, 480), embed("dark", 960, 140, 480)]
for j,s in enumerate([180,120,64,32]):
    x0 = 120 + sum([180,120,64,32][:j]) + j*60
    o.append(embed("light", x0, 700 + (180-s)//2, s))
    o.append(embed("dark", 800 + x0, 700 + (180-s)//2, s))
o.append('<text x="120" y="940" font-family="Segoe UI,sans-serif" font-size="20" fill="#8A8299">180 / 120 / 64 / 32 px</text>')
o.append('<text x="920" y="940" font-family="Segoe UI,sans-serif" font-size="20" fill="#8C88A8">180 / 120 / 64 / 32 px</text>')
o.append('</svg>')
open("glass-board.svg","w",encoding="utf-8").write("\n".join(o))
