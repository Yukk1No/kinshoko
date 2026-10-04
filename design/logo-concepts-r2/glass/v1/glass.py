# Liquid-glass app icon study for the keyhole bookmark (A) + sparkle (C).
BM = ("M82 20 H174 A18 18 0 0 1 192 38 V236 L128 192 L64 236 V38 A18 18 0 0 1 82 20 Z")
KH = "M116 117.8 A26 26 0 1 1 140 117.8 L147 158 H109 Z"
def star(cx, cy, r, k=0.16):
    d = r*k
    return (f"M{cx} {cy-r} C{cx+d} {cy-d} {cx+d} {cy-d} {cx+r} {cy} C{cx+d} {cy+d} {cx+d} {cy+d} {cx} {cy+r} "
            f"C{cx-d} {cy+d} {cx-d} {cy+d} {cx-r} {cy} C{cx-d} {cy-d} {cx-d} {cy-d} {cx} {cy-r} Z")
ST = star(194, 46, 40)
S = 2.75; TX = 512-128*S; TY = 512-128*S-6

def icon(id, bg1, bg2, glow, g_top, g_bot, g_op, rim, st_top, st_bot, shadow, kh_tint):
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
 <filter id="{id}blur2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<g clip-path="url(#{id}tile)">
 <rect width="1024" height="1024" fill="url(#{id}bg)"/>
 <rect width="1024" height="1024" fill="url(#{id}gl)"/>
 <path d="M0 0 H1024 V300 C700 380 320 260 0 360 Z" fill="#fff" opacity="0.05"/>
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
   <path d="M60 14 H200 V70 C160 92 104 96 60 86 Z" fill="url(#{id}spec)" opacity="0.7"/>
   <path d="M70 230 L128 188 L186 230" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="5"/>
  </g>
  <!-- sparkle: second glass layer overlapping the corner -->
  <path d="{ST}" transform="translate(2 8)" fill="{shadow}" opacity="0.35" filter="url(#{id}blur2)"/>
  <path d="{ST}" fill="url(#{id}st)" opacity="0.92"/>
  <g clip-path="url(#{id}stc)"><path d="{ST}" fill="none" stroke="#fff" stroke-opacity="0.7" stroke-width="3"/>
   <circle cx="186" cy="34" r="10" fill="#fff" opacity="0.55" filter="url(#{id}blur2)"/></g>
 </g>
 <!-- tile edge light -->
 <rect x="3" y="3" width="1018" height="1018" rx="225" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="6"/>
</g>
</svg>'''

V = {
 "night": dict(bg1="#3A3466", bg2="#17152A", glow="#8C7BD8", g_top="#FFF6E2", g_bot="#E9C985", g_op=0.9, rim=0.9,
               st_top="#FFE6A6", st_bot="#E3A93C", shadow="#05040C", kh_tint="#2B2747"),
 "day":   dict(bg1="#FFFDF8", bg2="#ECE5F3", glow="#F6C9D5", g_top="#5C5492", g_bot="#2B2747", g_op=0.88, rim=0.75,
               st_top="#FFB7C7", st_bot="#E0768F", shadow="#4B3F6B", kh_tint="#FFFFFF"),
 "sakura":dict(bg1="#F59AAE", bg2="#8E6FD0", glow="#FFE3EA", g_top="#FFFFFF", g_bot="#F1E8FF", g_op=0.62, rim=1.0,
               st_top="#FFF3C8", st_bot="#F2C14E", shadow="#3B2366", kh_tint="#5A3C8F"),
}
for k, v in V.items():
    open(f"icon-glass-{k}.svg","w",encoding="utf-8").write(icon(k, **v))
