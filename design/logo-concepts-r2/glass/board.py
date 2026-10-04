# Day/night pairing + liquid-glass icon board (HTML, screenshotted by render_png.py).
import os, sys
os.chdir(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ".")
import combo
INK, CREAM, GOLD, SAKURA, PAPER = combo.INK, combo.CREAM, combo.GOLD, combo.SAKURA, combo.PAPER
def lk(fg, ac):
    return f'<svg viewBox="0 0 990 256" style="width:100%;height:auto">{combo.lockup(fg, ac, "star", 10, 0, 1)}</svg>'
icons = ["night", "day", "sakura"]
def big(n, label):
    return f'<figure><img src="icon-glass-{n}.svg" width="300" height="300"><figcaption>{label}</figcaption></figure>'
small = "".join(f'<img src="icon-glass-{n}.svg" width="{s}" height="{s}">' for n in icons for s in (96, 48, 32))
html = f'''<!doctype html><meta charset="utf-8"><style>
body{{margin:0;background:#E9E5DD;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;color:#1a1a1a}}
.wrap{{width:1400px;padding:48px 60px;box-sizing:border-box}}
h1{{font-size:36px;margin:0 0 6px}} p.sub{{margin:0 0 28px;color:#666;font-size:19px}}
.row{{display:flex;gap:28px;margin-bottom:28px}}
.panel{{flex:1;min-width:0;border-radius:22px;padding:44px 40px 22px;box-sizing:border-box}}
.panel small{{display:block;margin-top:22px;font-size:16px;opacity:.6}}
figure{{margin:0;text-align:center}} figcaption{{margin-top:10px;font-size:17px;color:#555}}
.icons{{background:#fff;border-radius:22px;padding:36px 40px;display:flex;justify-content:space-around}}
.small{{background:#fff;border-radius:22px;padding:24px 40px;margin-top:28px;display:flex;align-items:flex-end;gap:22px}}
.small span{{font-size:15px;color:#999;margin-left:auto}}
</style><div class="wrap">
<h1>Kinshoko — 白天 / 黑夜 + Liquid Glass 图标</h1>
<p class="sub">锁孔书签 × 闪光字标。扁平主标用于界面与文档；玻璃质感仅用于 app 图标。</p>
<div class="row">
 <div class="panel" style="background:{PAPER};color:{INK}">{lk(INK, SAKURA)}<small>白天 · 纸白 #F7F3EA · 墨紫 #2B2747 · 樱粉 #E0768F</small></div>
 <div class="panel" style="background:{INK};color:{CREAM}">{lk(CREAM, GOLD)}<small>黑夜 · 墨紫 #2B2747 · 奶油 #F4ECDC · 金 #E3B34F</small></div>
</div>
<div class="icons">{big("day","白天 · 墨紫玻璃")}{big("night","黑夜 · 奶油金玻璃")}{big("sakura","樱紫 · 磨砂白玻璃（备选）")}</div>
<div class="small">{small}<span>96 / 48 / 32 px</span></div>
</div>'''
open("glass/board.html", "w", encoding="utf-8").write(html)
