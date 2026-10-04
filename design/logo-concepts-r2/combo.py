# A symbol + C wordmark combination study.
import re
sym = re.search(r'<path.*?/>', open("a-keyhole.svg",encoding="utf-8").read(), re.S).group(0)
wm_full = open("c-sparkle-k-lockup.svg",encoding="utf-8").read()
wm = wm_full.split('\n',1)[1].rsplit('</svg>',1)[0]
star_path = re.search(r'(<path d="M132 32.*?/>)', wm).group(1)
wm_letters = wm.replace(star_path, "")
dot = '<circle cx="132" cy="64" r="15"/>'

def lockup(fg, accent, i="star", x=0, y=0, s=1.0):
    k = 178/216
    mark = sym.replace('<path', f'<path fill="{fg}"')
    letters = wm_letters.replace('stroke="#000"', f'stroke="{fg}"')
    idot = star_path.replace('<path', f'<path fill="{accent}"') if i=="star" else dot.replace('<circle', f'<circle fill="{accent}"')
    return (f'<g transform="translate({x} {y}) scale({s})">'
            f'<g transform="translate(0 {33-20*k:.2f}) scale({k:.4f})">{mark}</g>'
            f'<g transform="translate(192 0)">{letters}{idot}</g></g>')

def stacked(fg, accent, x, y, s):
    k = 1.0
    mark = sym.replace('<path', f'<path fill="{fg}"')
    letters = wm_letters.replace('stroke="#000"', f'stroke="{fg}"')
    idot = star_path.replace('<path', f'<path fill="{accent}"')
    return (f'<g transform="translate({x} {y}) scale({s})">'
            f'<g transform="translate(267 0)">{mark}</g>'
            f'<g transform="translate(0 270)">{letters}{idot}</g></g>')

def tile(bg, fg, x, y, size):
    s = size/256*0.62
    off = size*0.19
    mark = sym.replace('<path', f'<path fill="{fg}"')
    return (f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{size*0.225}" fill="{bg}"/>'
            f'<g transform="translate({x+off+(size*0.62-128*s*2)/2+size*0.0} {y+off}) scale({s})"><g transform="translate(0 -6)">{mark}</g></g>')

INK, CREAM, GOLD, SAKURA, PAPER = "#2B2747", "#F4ECDC", "#E3B34F", "#E0768F", "#F7F3EA"
W, H = 1600, 1280
o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
     f'<rect width="{W}" height="{H}" fill="#EEEBE4"/>',
     '<text x="60" y="80" font-family="Segoe UI,sans-serif" font-weight="700" font-size="40" fill="#1a1a1a">Kinshoko — A × C combination study</text>',
     '<text x="60" y="118" font-family="Microsoft YaHei UI,Segoe UI,sans-serif" font-size="22" fill="#666">锁孔书签 + 圆头单线字标 · 两种 i 点 · 两套配色候选（墨紫×金 / 纸白×樱粉）</text>']
panels = [  # x,y,w,h,bg,fg,accent,i,label
 (60,150,720,300,"#FFFFFF","#111111","#111111","star","1 · i 点＝闪光"),
 (820,150,720,300,"#FFFFFF","#111111","#111111","dot","2 · i 点＝圆点"),
 (60,490,720,300,INK,CREAM,GOLD,"star","3 · 墨紫 × 奶油 × 金"),
 (820,490,720,300,PAPER,INK,SAKURA,"star","4 · 纸白 × 墨紫 × 樱粉"),
]
for x,y,w,h,bg,fg,ac,i,lab in panels:
    o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="20" fill="{bg}"/>')
    o.append(lockup(fg, ac, i, x+70, y+60, 0.6))
    lc = "#999" if bg in ("#FFFFFF",PAPER) else "#8C88A8"
    o.append(f'<text x="{x+28}" y="{y+h-24}" font-family="Microsoft YaHei UI,sans-serif" font-size="20" fill="{lc}">{lab}</text>')
# bottom row: app tiles + small sizes + stacked
o.append(f'<rect x="60" y="830" width="1480" height="390" rx="20" fill="#FFFFFF"/>')
o.append(tile(INK, CREAM, 100, 880, 180))
o.append(tile(SAKURA, "#FFFFFF", 310, 880, 180))
o.append(tile(PAPER, INK, 520, 880, 180))
o.append(f'<rect x="520" y="880" width="180" height="180" rx="40.5" fill="none" stroke="#E2DDD2" stroke-width="2"/>')
for j,(sz) in enumerate([64,32,16]):
    xx = 100 + j*90; yy = 1100 + (64-sz)
    o.append(tile(INK, CREAM, xx, yy, sz))
o.append('<text x="100" y="1196" font-family="Segoe UI,sans-serif" font-size="16" fill="#999">app icon · 64 / 32 / 16 px</text>')
o.append(stacked(INK, SAKURA, 900, 880, 0.55))
o.append('</svg>')
open("combo-ac.svg","w",encoding="utf-8").write("\n".join(o))
# standalone lockups for later
for name,(fg,ac,i) in {"ac-lockup-star":("#000","#000","star"),"ac-lockup-dot":("#000","#000","dot")}.items():
    open(f"{name}.svg","w",encoding="utf-8").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 990 256">{lockup(fg,ac,i,10,0,1)}</svg>')
