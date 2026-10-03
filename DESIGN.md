---
name: "Kinshoko 资料库浏览交互样稿"
description: "已实现的 throwaway web prototype；候选布局与浅深模式待画师选择。"
colors:
  canvas: "#17191b"
  light-canvas: "#f3f4f1"
  chrome: "#222528"
  light-chrome: "#e9ece7"
  panel: "#292c30"
  light-panel: "#fbfcf9"
  ink: "#eef0ee"
  light-ink: "#262c28"
  secondary: "#b4bbb7"
  light-secondary: "#616a63"
  line: "#3e4443"
  light-line: "#cbd1c9"
  accent: "#c4c9a8"
  light-accent: "#526743"
  selected-ink: "#20261c"
  light-selected-ink: "#fff"
  active: "#394034"
  light-active: "#e0e8d9"
  hover: "#303639"
  light-hover: "#e0e5de"
  image-ground: "#121415"
  light-image-ground: "#e0e3df"
  warning: "#edb7ab"
  light-warning: "#933d2f"
typography:
  headline:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", sans-serif"
    fontSize: "23px"
    fontWeight: 600
    letterSpacing: "-.02em"
  title:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", sans-serif"
    fontSize: "16px"
    fontWeight: 650
    letterSpacing: "-.02em"
  body:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
  copy:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", sans-serif"
    fontSize: "12px"
    lineHeight: 1.8
  control:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", sans-serif"
    fontSize: "12px"
    lineHeight: 1
  label:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", sans-serif"
    fontSize: "11px"
  caption:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", sans-serif"
    fontSize: "10px"
rounded:
  tag: "6px"
  tooltip: "7px"
  control: "8px"
  surface: "12px"
spacing:
  space-5: "5px"
  space-6: "6px"
  space-7: "7px"
  space-8: "8px"
  space-10: "10px"
  space-12: "12px"
  space-16: "16px"
  space-20: "20px"
  space-24: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.selected-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  button-text:
    textColor: "{colors.secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 10px"
  button-text-active:
    backgroundColor: "{colors.active}"
    textColor: "{colors.accent}"
  button-icon:
    textColor: "{colors.secondary}"
    rounded: "{rounded.control}"
    padding: "7px"
    width: "34px"
  button-icon-compact:
    textColor: "{colors.secondary}"
    rounded: "{rounded.control}"
    padding: "5px"
    width: "29px"
  button-neutral-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  search-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "34px"
    width: "340px"
  navigation-item:
    textColor: "{colors.secondary}"
    rounded: "{rounded.surface}"
    height: "44px"
    width: "42px"
  navigation-item-active:
    backgroundColor: "{colors.active}"
    textColor: "{colors.accent}"
  tag:
    textColor: "{colors.secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "0 9px"
    height: "26px"
  tag-active:
    backgroundColor: "{colors.active}"
    textColor: "{colors.accent}"
  picture-card:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.surface}"
    padding: "0"
  settings-drawer:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    padding: "20px"
    width: "330px"
  viewer-toolbar:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.secondary}"
    padding: "6px 12px"
---

# Design System: Kinshoko 资料库浏览交互样稿

## Overview

**Creative North Star: "图片占据主要空间"**

这是 `prototype/library-browser` 已实现的一次性网页交互样稿的记录，供当前样稿保持一致；不是 Kinshoko 正式桌面产品的视觉定稿。用户确认的图标侧栏、Axolotl Launcher 轻量状态动效参考、尽量留给图片的空间，以及 demo 必须有瀑布流，是本记录的依据。没有新增品牌隐喻，也没有已批准的视觉稿。

A／B／C、浅／深模式、密度与极长图策略均是画师可试用的候选；当前默认 A 和深色不代表最终选择。React／TypeScript／Vite、Lucide 与 TanStack Virtual 是这份网页样稿的实现事实，正式技术栈未确认。本文只描述源码，不宣告画师验收或评审全表面通过。

证据来自 `src/styles.css`、`src/App.tsx`、`src/Masonry.tsx`、`src/Viewer.tsx`，并对齐本表面的方向合同、PRODUCT.md、GLOSSARY.md 与领域 ADR。资料库仍使用领域定义；“本地试排”仅在浏览器内存中持有文件对象。Windows 原生 Tauri 窗口、ICC／色彩、GPU、混合 DPI、桌面钉图、持久资料库、备份及恢复均未实现或未验证。 复测与评审范围见[样稿复测与评审记录](.impeccable/review/README.md)；该索引保留实际结论与范围，本文不扩展验收结论。

**Key Characteristics:**

- 低彩度界面表面与一个强调色，图片观察区保持中性。
- 紧凑 SVG 图标导航，选中背景、指示线与文字提示可辨。
- 自然比例图片完整展示，缩略图与查看区不做装饰变换。
- 状态、失败恢复和样稿边界随操作可见。

## Colors

当前两套候选以低彩度背景、层次相邻的表面和一组偏灰绿的强调色组织界面；frontmatter 的无前缀值对应深色，`light-` 对应浅色。键保留源码的角色名，表述不另定义色值。

### Primary

- **灰绿强调色**（`accent`／`light-accent`）：主要文件选择动作、导航指示、选中与键盘焦点。
- **选中内文**（`selected-ink`／`light-selected-ink`）：强调色填充上的文字；并非另一组强调色。

### Neutral

- **工作底面**（`canvas`）：主窗口、搜索框及滚动轨道。
- **工具表面**（`chrome`）：侧栏、头尾工具区与卡片标题底。
- **面板表面**（`panel`）：侧面板、图片信息、操作提示与重试提示。
- **正文／辅助内文**（`ink`／`secondary`）：主要内容、控件文字与元数据层级；导航提示反转使用这组前景与底面。
- **分隔／悬浮／选中底**（`line`／`hover`／`active`）：一像素边界和状态表面。
- **图片底面**（`image-ground`）：缩略图与查看区的中性衬底；透明图使用样式中的低对比棋盘。
- **警示内文**（`warning`）：读取失败与从本次结果移除相关控件。浅色主题在以上同名角色前加 `light-`。

**The 单强调色 Rule.** 每个候选主题使用同一个 accent 连接选中、焦点和主要动作；warning 只表示失败或移除相关反馈，不成为第二个品牌强调色。

`.impeccable/design.json` 的八阶色条由现有色值合成，仅供文档面板展示；它们没有用于样稿，也不建立新的产品色阶。源码中尚未使用的 `--raised` 不进入规范 token。

## Typography

**Display Font:** 无独立 display 角色；这是紧凑操作界面。

**Body Font:** frontmatter 中的 Windows／中文同一字体栈；不额外下载字体。

**Character:** 同一界面字体栈维持控件和中文内文的连贯性。字体选择是网页样稿的当前事实，正式产品字体仍待验证。

### Hierarchy

- **Headline:** 仅 B 候选的筛选区标题；小窗口缩为（20px），不作为全产品展示字体规范。
- **Title:** 头部 Kinshoko 名称；小窗口缩为（15px）。
- **Body:** 根元素继承基准；实际密集控件多使用 control 与 label。
- **Copy:** 侧面板说明、设置帮助与状态提示；实际行高依语境为（1.7／1.8／1.9），frontmatter 收录重复使用的说明段落值。
- **Control / Label / Caption:** 依次用于文字按钮与搜索、辅助说明与图名、页脚说明。卡片样本类别为（9px），属于当前卡片局部元数据。

面板标题（18px／600）和空状态标题（19px／550；20px／500）按各组件现状保留；没有将这些局部尺寸扩展为新排版级别。缩放百分比及信息数值使用等宽数字。

## Layout

窗口为（100vw × 100dvh）的 flex 操作空间，外壳不滚动；图片结果区独立滚动。常规图标轨（64px）、顶部工具区（66px）、浏览工具行最小（44px）、底部状态区（30px）。主区域可收缩，避免工具挤占剩余图片空间。

默认瀑布流由当前 TanStack Virtual lanes 组织；列数由可用宽度和密度目标计算，列间及项间距（10px），图片区域横向与起始留白（12px），底部留白（80px）。密度目标为紧凑（164px）、标准（220px）、舒展（300px）；C 将目标限制至最多（170px）。这些是原型控制值，不是固定图片宽度。自然比例高度加（34px）标题条，极长图限制开关当前默认开启，上限（560px）；等尺寸网格只作留白对照，图像依然完整展示。

三种候选共同保留瀑布流：A 为结果墙与覆盖式原图查看；B 为前置搜索／标签与选中后右侧详情（36%，至少 310px）；C 为左侧观察区与右侧结果区（flex 1.45:1）。它们留在表面 brief 中比较，不作为全产品布局赢家。

在（1100px）断点内收紧工具间隔，隐藏部分辅助文案，B 详情改为（39%，至少 285px）。在（720px）断点内，侧栏缩为（50px），普通头部换为（102px）双行，B 头部为（56px）；B 详情覆盖结果并按对话框处理；C 上下堆叠，观察区占（48%）。设置侧面板始终限制在窗口减去侧栏的宽度内。

滚动锚点以图片身份与相对位置记录；重新排布、查看返回、切换候选与短暂无匹配时由应用恢复上下文。图片区使用稳定滚动槽并关闭浏览器自动锚定，避免与应用锚点同时控制位置。这是源码行为记录，已验证场景与边界见复测记录。

**The 完整构图 Rule.** 缩略图与原图查看保持等比完整展示；极长图上限以等比缩小实现，图片像素不参与悬浮或导航装饰动画。

## Elevation & Depth

工具、卡片和观察区以中性表面与一像素分隔形成层次。图片卡片本身没有投影；遮盖式信息、通知、状态及重试提示使用当前主题的柔和面板阴影，右侧抽屉另有横向阴影。具体阴影值在 sidecar 的 extensions 中，未占用 frontmatter 的组件属性。

导航文字与背景过渡（180ms），图标悬浮上移（1px）；选中指示线的 top 跟随（210ms），文字提示淡入（150ms）。侧面板进入（190ms）由水平（12px）偏移和（0.8）透明度回到原位；共用源码的 `--ease`。系统 `prefers-reduced-motion` 或样稿开关关闭动画、过渡及平滑滚动。

**The 控件动、图片稳 Rule.** 已实现动效仅作用于图标、导航状态、提示及侧面板；系统或手动减少动画时关闭过渡与动画。

## Shapes

现有控件按用途复用圆角：标签较紧，文字提示与选择框略弯，按钮／搜索使用 control，导航／图片卡片／图片信息与通知使用 surface。圆角值由 frontmatter 对应角色提供。分隔以（1px）直线为主，卡片裁切容器外缘，不裁去图像构图；透明图棋盘周期（16px）。

主要图标来自 Lucide SVG，导航图标（22px／1.75 描边），品牌图标（24px／1.8 描边）；工具图标多为（14–18px）。可访问文字由 aria 名称和提示提供。开发模式结构切换条的胶囊与圆形按钮只服务候选比较，不建立产品形状规范。

## Components

### Buttons

主要文件选择按钮以 accent 与 selected-ink 填充，文字／图标按钮维持辅助内文与透明默认底。常规控件最小高度（34px），紧凑图标按钮（29px）；圆角与内距见 frontmatter。主要按钮悬浮亮度（1.08），中性按钮悬浮使用 hover 与 ink，活动文字按钮使用 active 与 accent；禁用透明度（0.46）。

通用键盘焦点为强调色（2px）外框及（3px）偏移。未实现通用错误按钮或额外按下视觉，不为文档补造状态。

### Chips

手工样本标签使用细边、低密度文字，选中时同时显示强调色边界、active 背景与 SVG 勾选。多选条件同时满足，aria-pressed 标识选中；清除恢复全部结果。这不代表自动打标能力。

### Cards / Containers

图片卡片以自然比例图像区域与固定标题条组成；图名截断，类别保持短文案。鼠标选择、Space 选择和键盘焦点独立：选中外框（2px／偏移 0），键盘焦点（2px／偏移 3px）。悬浮只改变标题底面。单项读取失败保留卡位、错误说明和重试入口，不阻断其他图片。

图片信息、操作提示和状态面板沿用 panel；图片信息提供来源、稳定 ID、尺寸和手工标签。右抽屉为（330px），常规内距（20px），窄窗口（16px）；关闭、资料库试用入口和显示设置均为当前样稿动作。

### Inputs / Fields

搜索为一像素边框、canvas 底和 control 圆角；聚焦容器变为 accent 边界，输入本身取消内置 outline。普通搜索（34px），B 前置搜索（40px）；输入内文（12px），占位文案使用 secondary。支持 `/` 聚焦及有内容时清除。选择框使用同一角色；复选框以 accent 标识选中。没有已实现的字段校验错误态。

### Navigation

固定图标轨包括资料库／样本、浏览、显示设置及浅深切换。品牌图标与头部名称仅展示身份；资料库切换统一从“资料库与样本”进入，返回图片列表使用“浏览参考图”。默认 secondary，悬浮 hover／ink，活动 active／accent；文字提示同时响应悬浮和 focus-visible。窄窗口保留图标轨，不转换为其他导航结构。覆盖查看时背景交互由 inert 隔离。

### 原图查看与状态反馈

查看区支持适应、原始尺寸（一个图像像素对应一个 CSS 像素）、（5%–800%）缩放、前后图片和信息面板；fit 不放大小图，切换图片重置缩放及滚动。A 与窄窗口 B 按对话框约束焦点，Esc 返回浏览位置／收起详情。内联 B、C 继续共用同一查看组件。

无图片、无匹配、从本次结果全部移除有不同说明及选择／清除／恢复动作。失败提供重新选择与从本次结果移除；状态提示自动消失（7s）且可关闭。文件选择或拖入只读取 JPEG／PNG／WebP 到本次浏览内存，关闭或刷新清空，不代表资料库导入或保存。构造的（100／1,000／10,000）记录复用少量 URL，仅供布局与 DOM 工作量试用。

sidecar 的组件片段只演示已实现样式与可表达的 CSS 状态，不在文档面板中重建 React 行为；图片卡片预览留空图像 slot。它们不是新的视觉稿或验收截图。

## Do's and Don'ts

### Do:

- **Do** 保留图标导航的 SVG、可访问名称、悬浮／键盘提示与选中反馈。
- **Do** 保留参考图完整比例，以及选中、键盘焦点和返回浏览位置的区别。
- **Do** 使用当前主题同名角色切换色彩，让图片区域保持中性。
- **Do** 为无数据、无匹配、读取失败和内存试排保留明确状态与恢复动作。
- **Do** 同时遵守系统和样稿中的减少动画设置。

### Don't:

- **Don't** 为节省卡片高度裁去图片内容，或给图片像素加装饰变换。
- **Don't** 将 A／B／C、浅深模式或当前实现依赖称为已批准的正式布局、配色或技术栈。
- **Don't** 将开发专用结构切换条、诊断面板的局部样式或未使用变量推广成正式产品规范。
