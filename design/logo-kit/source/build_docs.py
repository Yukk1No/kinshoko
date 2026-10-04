"""One-page usage guide (HTML -> PDF/PNG) and the kit overview PNG, via headless Chrome.

Replaces build_guide.py (reportlab) and render_overview.cjs (playwright). Run after
export_kit.py and package_formats.py, from any directory.
"""
from pathlib import Path
import importlib.util

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('export_kit', ROOT / 'source/export_kit.py')
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)

VERSION, DATE = '1.1', '2026-10-04'
BOOK = ('M82 20 H174 A18 18 0 0 1 192 38 V236 L128 192 L64 236 V38 A18 18 0 0 1 82 20 Z '
        'M116 117.8 A26 26 0 1 1 140 117.8 L147 158 H109 Z')
SWATCHES = [('墨紫', '#2B2747'), ('奶油', '#F4ECDC'), ('金', '#E3B34F'), ('樱粉', '#E0768F'), ('纸白', '#F7F3EA')]

GUIDE = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Kinshoko Logo 使用规范 v{VERSION}</title>
<style>
@page{{size:A4;margin:0}}
:root{{--ink:#2B2747;--muted:#6E6680;--line:#E4DED3;--paper:#F7F3EA}}
*{{box-sizing:border-box;margin:0}}
html{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
body{{width:794px;height:1123px;padding:46px 56px 40px;font:12.5px/1.6 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif;color:var(--ink);background:#fff;overflow:hidden}}
h1{{font-size:27px;font-weight:600;letter-spacing:-.01em}}
.meta{{color:var(--muted);margin:4px 0 18px}}
.hero{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
.hero div{{border-radius:14px;padding:22px 22px 12px;display:flex;flex-direction:column;align-items:center;gap:10px}}
.hero img{{width:100%}} .hero span{{font-size:11px;opacity:.7;align-self:flex-start}}
.day{{background:var(--paper)}} .night{{background:var(--ink);color:#F4ECDC}}
section{{display:grid;grid-template-columns:150px 1fr;gap:18px;padding:12px 0;border-top:1px solid var(--line)}}
section:first-of-type{{margin-top:16px}}
h2{{font-size:14px;font-weight:600}} h2 small{{display:block;color:var(--muted);font-weight:400;font-size:11px;letter-spacing:.06em}}
ul{{padding-left:16px}} li{{margin:1px 0}} b{{font-weight:600}}
.row{{display:flex;gap:20px;align-items:center}}
.clear{{width:86px;flex:none}}
.sw{{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}}
.sw div{{font-size:11px}} .sw div::before{{content:"";display:block;height:34px;border-radius:7px;background:var(--c);border:1px solid rgba(0,0,0,.06);margin-bottom:5px}}
.sw code{{color:var(--muted);font:10.5px Consolas,monospace}}
.sizes{{display:flex;gap:16px;align-items:flex-end;margin-bottom:8px}}
.sizes figure{{text-align:center;font-size:10px;color:var(--muted)}} .sizes img{{display:block;margin:0 auto 3px}}
.apps{{display:flex;gap:12px;align-items:center;flex:none}} .apps img{{width:84px;height:84px}}
.donts{{color:var(--muted)}}
footer{{position:absolute;left:56px;right:56px;bottom:30px;display:flex;justify-content:space-between;color:var(--muted);font-size:10.5px}}
</style></head><body>
<h1>Kinshoko · Logo 使用规范</h1>
<div class="meta">v{VERSION} · {DATE} · 锁孔书签 + 圆头字标（i 点为星）· R6 玻璃 app 图标</div>
<div class="hero">
 <div class="day"><img src="../lockups/horizontal-day.svg" alt=""><span>白天 · 纸白底，墨紫 + 樱粉</span></div>
 <div class="night"><img src="../lockups/horizontal-night.svg" alt=""><span>夜间 · 墨紫底，奶油 + 金</span></div>
</div>
<section><h2>01 结构与留白<small>STRUCTURE</small></h2><div class="row">
 <svg class="clear" viewBox="30 -13 196 282"><rect x="37.3" y="-6.7" width="181.4" height="269.4" fill="none" stroke="#A49CB5" stroke-width="2" stroke-dasharray="6 5"/>
 <path fill="#2B2747" fill-rule="evenodd" d="{BOOK}"/><path d="M192 6 H218.7" stroke="#E0768F" stroke-width="2"/><text x="205" y="-0.5" font-size="15" fill="#E0768F" text-anchor="middle">X</text></svg>
 <ul><li><b>X</b> = 字标一笔的粗细（源几何 22 单位）。四周至少留 X，从可见轮廓起算。</li>
 <li>横排用于标题栏、页头、README；竖排用于封面与居中版面。</li>
 <li>字标是自绘路径，不要用字体重排；直接使用 <b>lockups/</b> 中的成品，保持比例与字距。</li></ul></div></section>
<section><h2>02 配色<small>COLOUR</small></h2><div>
 <div class="sw">{''.join(f'<div style="--c:{c}">{n}<br><code>{c}</code></div>' for n, c in SWATCHES)}</div>
 <p style="margin-top:8px">浅底：墨紫 + 樱粉；深底：奶油 + 金。单色用墨紫或纯黑，反白用纯白配足够深的底。玻璃图标的材质渐变是独立参数，不作品牌色使用。</p></div></section>
<section><h2>03 尺寸与小尺寸版<small>SIZES</small></h2><div>
 <div class="sizes">{''.join(f'<figure><img src="../web/png/icon-day-{s}.png" width="{s}" height="{s}">{s}</figure>' for s in (16, 24, 32, 48, 64))}
 {''.join(f'<figure><img src="../web/png/icon-night-{s}.png" width="{s}" height="{s}">{s}</figure>' for s in (16, 24, 32, 48, 64))}</div>
 <ul><li><b>16–20 px</b> micro：去星、放大锁孔；<b>24 px</b> compact；<b>32 px</b> small：星加底色描边，与书签角分开。三档都按像素网格对齐，不要用标准图缩放代替。</li>
 <li><b>40 px 起</b>用标准几何。高 DPI 按<b>显示尺寸</b>选版本：16 px 显示用 micro@2x，而不是 32 px 版本。</li>
 <li>横排宽度 ≥ 120 px，竖排宽度 ≥ 112 px。</li></ul></div></section>
<section><h2>04 玻璃 app 图标<small>APP ICON</small></h2><div class="row">
 <div class="apps"><img src="../app/png/light/icon-256.png" alt=""><img src="../app/png/dark/icon-256.png" alt=""></div>
 <ul><li>R6 玻璃版用于桌面图标、启动器、Dock，显示尺寸 ≥ 40 px。</li>
 <li>三层按 ⓪ 背景 → ① 书签（锁孔透明）→ ② 星星叠放，同一 1024 画布与原点。</li>
 <li>ICO / ICNS 中 ≤ 32 px 的帧已换成扁平小尺寸版；网页、favicon、托盘一律用扁平版。</li></ul></div></section>
<section><h2>05 不要这样做<small>DON'TS</small></h2><ul class="donts">
 <li>拉伸、旋转、改字距，或把字标换成字体排版。</li>
 <li>填实锁孔、给扁平标志加阴影 / 描边 / 渐变；玻璃光效只属于 app 图标。</li>
 <li>放在复杂图片上——先给一块稳定的底色。</li></ul></section>
<footer><span>文件：master · symbols · wordmarks · lockups · web · app</span><span>Kinshoko Logo Kit v{VERSION}</span></footer>
</body></html>
'''


def main():
    docs = ROOT / 'docs'
    guide = docs / 'usage-guide.html'
    guide.write_text(GUIDE, encoding='utf-8')
    export.print_pdf(guide, docs / 'usage-guide.pdf')
    export.screenshot(guide, ROOT / 'preview/usage-guide.png', 794, 1123)
    export.screenshot(ROOT / 'preview/overview.html', ROOT / 'preview/overview.png', 1440, 1572)
    print('Wrote docs/usage-guide.{html,pdf} and preview/{usage-guide,overview}.png')


if __name__ == '__main__':
    main()
