# Round-2 concept builder: writes symbol + lockup SVGs for five concepts.
def star(cx, cy, r, k=0.18):
    # 4-point sparkle with concave sides; k = pinch toward centre
    d = r * k
    return (f"M{cx} {cy-r} C{cx+d} {cy-d} {cx+d} {cy-d} {cx+r} {cy} "
            f"C{cx+d} {cy+d} {cx+d} {cy+d} {cx} {cy+r} "
            f"C{cx-d} {cy+d} {cx-d} {cy+d} {cx-r} {cy} "
            f"C{cx-d} {cy-d} {cx-d} {cy-d} {cx} {cy-r} Z")

S = {}
# A keyhole bookmark
S["a-keyhole"] = '''<path fill-rule="evenodd" d="M82 20 H174 A18 18 0 0 1 192 38 V236 L128 192 L64 236 V38 A18 18 0 0 1 82 20 Z
 M116 117.8 A26 26 0 1 1 140 117.8 L147 158 H109 Z"/>'''
# B catchlight iris
S["b-catchlight"] = f'''<path d="M34 96 Q128 30 222 96" fill="none" stroke="#000" stroke-width="24" stroke-linecap="round"/>
 <path fill-rule="evenodd" d="M128 68 C176 68 190 120 190 156 C190 202 164 236 128 236 C92 236 66 202 66 156 C66 120 80 68 128 68 Z
 M{star(104,148,28,0.16)[1:]}
 M156 200 A11 11 0 1 0 156 200.01 Z"/>'''
# C wordmark k
S["c-sparkle-k"] = f'''<g fill="none" stroke="#000" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
 <path d="M76 40 V216"/><path d="M162 104 L80 168"/><path d="M118 140 L170 216"/></g>
 <path d="{star(176,46,32,0.16)}"/>'''
# D ahoge book
S["d-ahoge"] = '''<path d="M24 108 C68 94 106 100 123 116 V232 C106 218 68 212 24 224 Z M133 116 C150 100 188 94 232 108 V224 C188 212 150 218 133 232 Z"/>
 <path d="M122 112 C112 70 136 34 186 22 C152 44 136 72 134 112 Z"/>'''
# E spell frame
def bracket(x, y, sx, sy, L=36, t=18):
    return (f"M{x} {y} H{x+sx*L} V{y+sy*t} H{x+sx*t} V{y+sy*L} H{x} Z")
E_br = " ".join([bracket(66,66,1,1), bracket(190,66,-1,1), bracket(66,190,1,-1), bracket(190,190,-1,-1)])
S["e-spell"] = f'''<path fill-rule="evenodd" d="M128 12 A116 116 0 1 1 127.99 12 Z M128 30 A98 98 0 1 0 128.01 30 Z"/>
 <path d="{E_br}"/><path d="{star(128,128,44,0.16)}"/>'''

hdr = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">\n'
for k, body in S.items():
    open(f"{k}.svg","w",encoding="utf-8").write(hdr + body + "\n</svg>\n")

# lockups (exploration: live <text>)
TXT = '''<text x="276" y="150" font-family="'Segoe UI Variable Display','Segoe UI',Inter,sans-serif" font-weight="600" font-size="100" letter-spacing="-2" fill="#000">Kinshoko</text>
<text x="282" y="204" font-family="'Yu Gothic UI','Noto Sans JP',sans-serif" font-weight="500" font-size="30" letter-spacing="16" fill="#000">禁書庫</text>'''
for k, body in S.items():
    if k == "c-sparkle-k": continue
    open(f"{k}-lockup.svg","w",encoding="utf-8").write(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 780 256">\n<!-- exploration lockup: live text -->\n'
        f'<g transform="translate(10 28) scale(0.78)">{body}</g>\n{TXT}\n</svg>\n')

# C: custom monoline wordmark, i-dot sparkle (no live text)
W = '''<g fill="none" stroke="#000" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
<path d="M30 44 V200"/><path d="M96 104 L34 156"/><path d="M62 134 L100 200"/>
<path d="M132 108 V200"/>
<path d="M168 200 V108 M168 146 A32 32 0 0 1 232 146 V200"/>
<path d="M314 120 C306 104 268 98 266 124 C264 148 318 146 318 174 C318 204 274 206 262 186"/>
<path d="M352 44 V200 M352 146 A32 32 0 0 1 416 146 V200"/>
<circle cx="490" cy="154" r="46"/>
<path d="M568 44 V200"/><path d="M634 104 L572 156"/><path d="M600 134 L638 200"/>
<circle cx="716" cy="154" r="46"/>
</g>'''
open("c-sparkle-k-lockup.svg","w",encoding="utf-8").write(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 790 256">\n' + W +
  f'\n<path d="{star(132,58,26,0.16)}"/>\n</svg>\n')
