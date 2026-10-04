# Layered "liquid glass" app icon for the A (keyhole bookmark) direction.
# Layers: 0 background tile + light glow, 1 glass bookmark (keyhole is a real hole), 2 glass sparkle.
BOOK = ("M82 20 H174 A18 18 0 0 1 192 38 V236 L128 192 L64 236 V38 A18 18 0 0 1 82 20 Z "
        "M116 117.8 A26 26 0 1 1 140 117.8 L147 158 H109 Z")

def star(cx, cy, r, k=0.16):
    d = r * k
    return (f"M{cx} {cy-r} C{cx+d} {cy-d} {cx+d} {cy-d} {cx+r} {cy} C{cx+d} {cy+d} {cx+d} {cy+d} {cx} {cy+r} "
            f"C{cx-d} {cy+d} {cx-d} {cy+d} {cx-r} {cy} C{cx-d} {cy-d} {cx-d} {cy-d} {cx} {cy-r} Z")

THEMES = {
  "light": dict(bg0="#FCF8F0", bg1="#EDE3D1", glow="#F2A0B4", glow_op=.75,
                body0="#6A62A8", body0_op=.80, body1="#2B2747", body1_op=.92,
                shadow="#2B2747", shadow_op=.30, acc0="#F7B3C3", acc1="#E0768F", sheen=.22, refr=.42),
  "dark":  dict(bg0="#3B3663", bg1="#18162A", glow="#E9B74F", glow_op=.70,
                body0="#FFFBF2", body0_op=.92, body1="#E6D9BE", body1_op=.80,
                shadow="#05040B", shadow_op=.55, acc0="#FBE2A0", acc1="#E3A93A", sheen=.45, refr=.55),
}
T = (153.6, 161.6, 2.8)          # bookmark placement: translate x, y, scale (256 → 1024 grid)
SPARK = star(716, 236, 104)

def icon(t, layers=(0,1,2)):
    c = THEMES[t]; tx, ty, s = T
    g = f'transform="translate({tx} {ty}) scale({s})"'
    return f'''<defs>
  <linearGradient id="bg-{t}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{c['bg0']}"/><stop offset="1" stop-color="{c['bg1']}"/></linearGradient>
  <radialGradient id="glow-{t}" cx="512" cy="520" r="340" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{c['glow']}" stop-opacity="{c['glow_op']}"/><stop offset=".55" stop-color="{c['glow']}" stop-opacity="{c['glow_op']*.35:.2f}"/><stop offset="1" stop-color="{c['glow']}" stop-opacity="0"/></radialGradient>
  <linearGradient id="body-{t}" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="{c['body0']}" stop-opacity="{c['body0_op']}"/><stop offset="1" stop-color="{c['body1']}" stop-opacity="{c['body1_op']}"/></linearGradient>
  <linearGradient id="rim-{t}" x1="64" y1="20" x2="192" y2="236" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FF9EC7"/><stop offset=".3" stop-color="#FFE08A"/><stop offset=".55" stop-color="#8FE9FF"/><stop offset=".8" stop-color="#B7A2FF"/><stop offset="1" stop-color="#FF9EC7"/></linearGradient>
  <linearGradient id="spec-{t}" x1="64" y1="20" x2="192" y2="236" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset=".38" stop-color="#fff" stop-opacity="0"/><stop offset=".78" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".6"/></linearGradient>
  <linearGradient id="sheen-{t}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="{c['sheen']}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="acc-{t}" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="{c['acc0']}" stop-opacity=".95"/><stop offset="1" stop-color="{c['acc1']}" stop-opacity=".88"/></linearGradient>
  <linearGradient id="srim-{t}" x1="612" y1="132" x2="820" y2="340" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset=".7" stop-color="#8FE9FF" stop-opacity=".7"/><stop offset="1" stop-color="#FF9EC7"/></linearGradient>
  <clipPath id="tile-{t}"><rect width="1024" height="1024" rx="230"/></clipPath>
  <clipPath id="book-{t}"><path clip-rule="evenodd" d="{BOOK}"/></clipPath>
  <clipPath id="spark-{t}"><path d="{SPARK}"/></clipPath>
  <filter id="sh-{t}" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="shs-{t}" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="18"/></filter>
  <filter id="edge-{t}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
  <radialGradient id="refr-{t}" cx="128" cy="140" r="120" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{c['glow']}" stop-opacity="{c['refr']}"/><stop offset="1" stop-color="{c['glow']}" stop-opacity="0"/></radialGradient>
  <linearGradient id="thick-{t}" x1="0" y1="20" x2="0" y2="236" gradientUnits="userSpaceOnUse"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient>
  <filter id="soft-{t}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation=".9"/></filter>
</defs>
<g clip-path="url(#tile-{t})">
  {'' if 0 in layers else '<!--'}
  <rect width="1024" height="1024" fill="url(#bg-{t})"/><circle cx="512" cy="520" r="340" fill="url(#glow-{t})"/>{'' if 0 in layers else '-->'}
  {'' if 1 in layers else '<!--'}
  <path fill-rule="evenodd" d="{BOOK}" transform="translate({tx} {ty+28}) scale({s})" fill="{c['shadow']}" opacity="{c['shadow_op']}" filter="url(#sh-{t})"/>
  <g {g}>
    <path fill-rule="evenodd" d="{BOOK}" fill="url(#body-{t})"/>
    <g clip-path="url(#book-{t})">
      <rect x="40" y="10" width="180" height="250" fill="url(#refr-{t})"/>
      <rect x="40" y="10" width="180" height="96" fill="url(#sheen-{t})"/>
      <path d="{BOOK}" fill="none" stroke="url(#thick-{t})" stroke-width="16" filter="url(#edge-{t})"/>
      <path d="{BOOK}" fill="none" stroke="url(#rim-{t})" stroke-width="4.5" opacity=".9" filter="url(#soft-{t})"/>
      <path d="{BOOK}" fill="none" stroke="url(#spec-{t})" stroke-width="2.4"/>
    </g>
  </g>
  {'' if 1 in layers else '-->'}{'' if 2 in layers else '<!--'}
  <path d="{SPARK}" transform="translate(-4 22)" fill="{c['shadow']}" opacity="{c['shadow_op']*.8:.2f}" filter="url(#shs-{t})"/>
  <path d="{SPARK}" fill="url(#acc-{t})"/>
  <g clip-path="url(#spark-{t})"><ellipse cx="690" cy="196" rx="70" ry="52" fill="#fff" opacity=".35" filter="url(#edge-{t})"/><path d="{SPARK}" fill="none" stroke="url(#srim-{t})" stroke-width="8" opacity="1" filter="url(#soft-{t})"/></g>{'' if 2 in layers else '-->'}
</g>
<rect opacity="{1 if 0 in layers else 0}" x="1" y="1" width="1022" height="1022" rx="229" fill="none" stroke="#fff" stroke-opacity="{.5 if t=='light' else .14}" stroke-width="2"/>'''

for t in THEMES:
    open(f"icon-{t}.svg","w",encoding="utf-8").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n{icon(t)}\n</svg>\n')

for t in THEMES:
    for n in (0,1,2):
        open(f"layer{n}-{t}.svg","w",encoding="utf-8").write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n{icon(t,(n,))}\n</svg>\n')
