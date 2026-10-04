# Kinshoko Logo Kit · v1.1

最终玻璃图标为用户确认的 **R6**。扁平字标沿用原 `logo-concepts-r2/combo-ac.svg` 第三、第四组：锁孔书签 + 圆头自绘字标，`i` 点为星星。截图中的横排组合已找回；套件内 SVG 不依赖字体。

先看 `preview/overview.html` 或 `preview/overview.png`，正式的一页规范位于 `docs/usage-guide.pdf`（源文件 `docs/usage-guide.html`）。

## v1.1 变更

- **小尺寸重新对齐像素**：16 px micro、24 px compact 按显示尺寸的像素网格重画；新增 **32 px small**（此前 32 px 由 24 px 图形放大，边缘发虚）。书签居中，与 1024 主图一致；24 / 32 px 的星星加底色描边，与书签角分开。
- **原生图标的小帧换成扁平版**：`app/native/*.ico` 的 16–32 px 帧、`*.icns` 的 16 / 32 pt 槽位（含 @2x）改用扁平小尺寸版，40 px 起仍是 R6 玻璃。ICO 增加 20 / 40 / 96 px 帧。
- **工具链精简**：导出、规范页和预览只需 Python 3 + Pillow + 本机 Chrome / Edge，不再依赖 Node（sharp / playwright）、reportlab、pypdf。
- **规范页重排**：改用 HTML 生成、Chrome 打印为 PDF，换成正常的比例字体；留白示意按真实比例绘制。
- R6 玻璃图标与三层源文件未改动（校验仍逐字节比对）。

## 资源导航

| 目录 | 内容 |
| --- | --- |
| `master/` | 书签、字标、app 组合的最终几何 SVG；16 px micro、24 px compact、32 px small 像素对齐几何；几何与色值 JSON |
| `symbols/` | 独立书签：标准 / micro / compact / small；日间、夜间、墨紫单色、纯黑、反白，各有 SVG / PNG |
| `wordmarks/` | 独立字标的双主题、单色和反白 SVG / PNG |
| `lockups/` | 横排与竖排组合：day / night 两色，以及 mono-ink / mono-black / reverse-white |
| `web/` | 扁平版 SVG、各尺寸 PNG、@2x / @3x 小尺寸 PNG、favicon SVG / ICO、Apple touch 图标、manifest 和 head 示例 |
| `app/svg/` | 原样复制的 R6 日夜整图 SVG |
| `app/layers/` | 0 背景 / 1 书签 / 2 星星；同画布、同原点的 SVG 与 512 / 1024 px 透明 PNG |
| `app/png/` | 日夜玻璃版 16、20、24、32、40、48、60、64、96、128、180、192、256、512、1024 px |
| `app/native/` | 日夜 Windows ICO、macOS ICNS；≤32 px 帧为扁平版，更大为 R6 玻璃 |
| `docs/` | 一页使用规范 PDF 及其 HTML 源、Markdown 摘要、来源说明、检查记录 |
| `source/` | 可复现的几何、导出、格式封装、规范和打包脚本；冻结的 R6 源与原字标几何 |

`day` / `night` 是扁平品牌主题；`light` / `dark` 是 R6 玻璃主题。全部主题版本均为成品，不是新设计候选。

## 常用入口

- 标题栏、网站页头：`lockups/horizontal-day.svg` / `horizontal-night.svg`。
- 封面、居中版面：`lockups/vertical-day.svg` / `vertical-night.svg`。
- 单色印刷：`*-mono-black.svg`；深底反白：`*-reverse-white.svg`。
- 网页：`web/head-snippet.html` 中的 `/brand/` 为示例资源目录，按项目实际路径调整。
- 系统托盘、16-20 px：优先 `symbols/bookmark-micro-*` 或 `web/svg/icon-*-micro.svg`。
- 高 DPI：使用 `web/png/retina/icon-day-16@2x.png` 等对应显示尺寸的文件。`icon-day-32.png` 是 32 px small，不能替代 16 px 的 micro @2x。
- 桌面 app：优先用 `app/native/` 中的容器（小帧已是扁平版）。`app/png/light/` / `dark/` 是 R6 玻璃的全尺寸导出，40 px 以下仅作参考，不建议直接显示。
- 叠图层：按 layer0、layer1、layer2 顺序放在同一个 1024 × 1024 画布；圆角之外与锁孔保持透明。

## 配色

| 扁平色值 | HEX |
| --- | --- |
| 墨紫 | `#2B2747` |
| 奶油 | `#F4ECDC` |
| 金 | `#E3B34F` |
| 樱粉 | `#E0768F` |
| 纸白 | `#F7F3EA` |

R6 的光学渐变色是独立的材质参数，位于 `source/build_app_r6.py`，不替代上面的扁平品牌色。

## 复现

需要 Python 3、Pillow 和本机 Chrome 或 Edge（找不到时设 `CHROME_PATH`）。在任意目录执行：

```powershell
python source/build_kit.py          # 几何与全部 SVG，写 export-jobs.json
python source/export_kit.py         # Chrome 栅格化：扁平 PNG、R6 玻璃各尺寸、图层 PNG
python source/package_formats.py    # favicon.ico、app ICO / ICNS
python source/build_docs.py         # 规范 HTML → PDF / PNG，概览 PNG
python source/verify_and_package.py # 校验并写 manifest / validation；加 --zip <目录> 另出压缩包
```

R6 成品与 `source/approved-r6/` 逐字节比对；规范只出一页；PNG 尺寸、ICO / ICNS 帧、锁孔透明度、图层叠合和原生小帧来源均有记录（`docs/validation.json`）。

当前交付为资源套件，未修改应用代码。网页 snippet 和 manifest 是可接入的示例，路径需与部署目录对应。
