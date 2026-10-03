---
version: 1
slug: "prototype-library-browser-src-app-tsx"
primary_target: "prototype/library-browser/src/App.tsx"
related_targets: ["prototype/library-browser/src/styles.css"]
---

# 资料库浏览交互样稿

Mode: Operate。面向 Windows 画师，用户已指定图标导航、Axolotl 动效参考和瀑布流，并选择直接交互样稿。布局是可试用候选，最终选择等待画师反馈。

## Direction contract

**THESIS:** 图片占据主要空间，完整构图、稳定图片身份和查看后的返回位置贯穿操作。瀑布流是必做实现，等尺寸布局只用于同图对照。

**OWN-WORLD:** 继承 Axolotl 的紧凑图标轨、可辨的选中背景与轻量状态反馈；颜色策略为 Restrained，以低彩度表面和一个强调色组织控件。画师在绘画窗口旁查图，图片观察区保持中性；样稿提供浅／深模式以比较实际使用场景。字体采用清楚的 Windows／中文界面栈。

**STORY:** 先浏览构造／公开样本，再选少量本地图片试排；查看、缩放和返回，调整密度或窗口，比较三种结构。内存样稿、素材来源和诊断状态清楚可见，不冒充已完成资料库写入。

**FIRST VIEWPORT:** 默认 A 为紧凑左图标轨＋单行主要工具＋占据其余窗口的瀑布流。完整图片以自然比例形成节奏；选中图可进入原图查看。B 把筛选任务放在前面，C 把观察大图放在左侧、候选瀑布流放在右侧。导航指示的轻量跟随是签名交互，图片像素不参与装饰变换。

**FORM:** grounded list 7／6／4，surface seed 178c3989；A／B／C 是可操作原型候选，用户参考约束优先，尚无正式布局赢家。

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 候选结构与未决项

用户给定的图标轨、瀑布流和参考动效在三种结构中共同保留。结构候选按任务适配性排序：1 图片浏览＋覆盖查看，2 图片浏览＋可收起筛选，3 并排详情，4 观察优先左大图／右结果，5 分类栏与图片浏览，6 筛选优先＋内联详情，7 全窗图片墙＋紧凑工具。7 的空间效率强，但初学操作的可发现性须验证，因此原始任务排序较低。

用户已选择可交互样稿，候选直接在同一路由中比较。原型布局、深浅模式、极端比例策略和动作预算均未冻结；真实画质、Windows 原生窗口与恢复验证另有范围。
