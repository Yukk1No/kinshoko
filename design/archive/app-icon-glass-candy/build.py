# Rejected glass app icons (night / sakura). Reproduces icon-night.svg and icon-sakura.svg:
#   python build.py
from pathlib import Path
BM = ("M98 20 H158 A34 34 0 0 1 192 54 V220 Q192 241 175 229 L137 199 Q128 192 119 199 L81 229 Q64 241 64 220 V54 A34 34 0 0 1 98 20 Z")
KH = "M116 117.8 A26 26 0 1 1 140 117.8 L145 151 Q146 158 139 158 H117 Q110 158 111 151 Z"
def star(cx, cy, r, k=0.16):
    d = r*k
    return (f"M{cx} {cy-r} C{cx+d} {cy-d} {cx+d} {cy-d} {cx+r} {cy} C{cx+d} {cy+d} {cx+d} {cy+d} {cx} {cy+r} "
            f"C{cx-d} {cy+d} {cx-d} {cy+d} {cx-r} {cy} C{cx-d} {cy-d} {cx-d} {cy-d} {cx} {cy-r} Z")
ST = star(194, 46, 40)
S = 2.75; TX = 512-128*S; TY = 512-128*S-6

def icon(id, bg1, bg2, glow, g_top, g_bot, g_op, rim, st_top, st_bot, shadow, kh_tint, b1, b2, b3, caustic):
    sw = 1/S
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
 <linearGradient id="{id}bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="{bg1}"/><stop offset="1" stop-color="{bg2}"/></linearGradient>
 <radialGradient id="{id}gl" cx="0.5" cy="0.42" r="0.55"><stop offset="0" stop-color="{glow}" stop-opacity="0.55"/><stop offset="1" stop-color="{glow}" stop-opacity="0"/></radialGradient>
 <linearGradient id="{id}body" x1="0.15" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="{g_top}"/><stop offset="1" stop-color="{g_bot}"/></linearGradient>
 <linearGradient id="{id}rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="{rim}"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="#fff" stop-opacity="{rim*0.6}"/></linearGradient>
 <linearGradient id="{id}spec" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
 <linearGradient id="{id}st" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{st_top}"/><stop offset="1" stop-color="{st_bot}"/></linearGradient>
 <linearGradient id="{id}kh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{kh_tint}" stop-opacity="0.55"/><stop offset="1" stop-color="{kh_tint}" stop-opacity="0.1"/></linearGradient>
 <clipPath id="{id}bmc"><path d="{BM} {KH}" clip-rule="evenodd"/></clipPath>
 <clipPath id="{id}khc"><path d="{KH}"/></clipPath>
 <clipPath id="{id}stc"><path d="{ST}"/></clipPath>
 <clipPath id="{id}tile"><rect width="1024" height="1024" rx="228"/></clipPath>
 <filter id="{id}blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
 <filter id="{id}blob" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>
 <filter id="{id}blur2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<g clip-path="url(#{id}tile)">
 <rect width="1024" height="1024" fill="url(#{id}bg)"/>
 <rect width="1024" height="1024" fill="url(#{id}gl)"/>
 <g filter="url(#{id}blob)"><circle cx="300" cy="330" r="150" fill="{b1}" opacity="0.75"/><circle cx="720" cy="700" r="190" fill="{b2}" opacity="0.7"/><circle cx="640" cy="300" r="90" fill="{b3}" opacity="0.6"/></g>
 <g transform="translate({TX:.1f} {TY:.1f}) scale({S})">
  <!-- cast shadow -->
  <path d="{BM}" transform="translate(4 14)" fill="{shadow}" opacity="0.45" filter="url(#{id}blur)"/>
  <!-- glass body -->
  <path d="{BM} {KH}" fill-rule="evenodd" fill="url(#{id}body)" opacity="{g_op}"/>
  <!-- keyhole depth -->
  <g clip-path="url(#{id}khc)"><path d="{KH}" fill="url(#{id}kh)"/>
   <path d="{KH}" fill="none" stroke="{shadow}" stroke-opacity="0.5" stroke-width="6" transform="translate(0 2)" filter="url(#{id}blur2)"/></g>
  <!-- inner rim light + specular -->
  <g clip-path="url(#{id}bmc)">
   <path d="{BM} {KH}" fill="none" stroke="url(#{id}rim)" stroke-width="{10*sw*S/2.75*1.0:.2f}"/>
   <ellipse cx="150" cy="215" rx="70" ry="34" fill="{caustic}" opacity="0.75" filter="url(#{id}blur)"/>
   <path d="M60 14 H200 V64 C160 84 104 88 60 80 Z" fill="url(#{id}spec)" opacity="0.45"/>
   <path d="{BM}" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="14" filter="url(#{id}blur2)"/>
  </g>
  <!-- sparkle: second glass layer overlapping the corner -->
  <path d="{ST}" transform="translate(2 8)" fill="{shadow}" opacity="0.35" filter="url(#{id}blur2)"/>
  <path d="{ST}" fill="url(#{id}st)" stroke="url(#{id}st)" stroke-width="7" stroke-linejoin="round" opacity="0.94"/>
  <g clip-path="url(#{id}stc)"><path d="{ST}" fill="none" stroke="#fff" stroke-opacity="0.7" stroke-width="3"/>
   <circle cx="186" cy="34" r="10" fill="#fff" opacity="0.55" filter="url(#{id}blur2)"/></g>
 </g>
 <!-- tile edge light -->
 <rect x="3" y="3" width="1018" height="1018" rx="225" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="6"/>
</g>
</svg>'''

V = {
 "night": dict(bg1="#332D5E", bg2="#141226", glow="#7F6DD6", g_top="#FFF7E6", g_bot="#EBC77E", g_op=0.84, rim=0.95,
               st_top="#FFEAB0", st_bot="#E3A93C", shadow="#05040C", kh_tint="#2B2747",
               b1="#6A5ACD", b2="#C2577E", b3="#E3B34F", caustic="#FFF2C8"),
 "sakura":dict(bg1="#F79DB1", bg2="#8A6BD0", glow="#FFE6EC", g_top="#FFFFFF", g_bot="#F3EAFF", g_op=0.6, rim=1.0,
               st_top="#FFF4CC", st_bot="#F2C14E", shadow="#3B2366", kh_tint="#5A3C8F",
               b1="#FFD1DC", b2="#6E4FC0", b3="#FFE7A0", caustic="#FFFFFF"),
}
for k, v in V.items():
    (Path(__file__).parent / f"icon-{k}.svg").write_text(icon(k, **v), encoding="utf-8", newline="")
