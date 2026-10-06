# 瀑布流图库的现成实现核查

2026-10-03（Asia/Shanghai）。用户要求在 UI demo 中验证瀑布流，以提高图片占用的空间比例。**仅核查公开文档、发布包和固定源码；未安装依赖、运行 demo 或测量性能。** 原提案中“等尺寸 VirtuosoGrid、瀑布流以后再评估”的范围应调整；React／TS 仍为候选。

## 实验建议

优先试 **`@tanstack/react-virtual 3.14.13` 的官方多列 `lanes` 方案**。这轮不仅要求完整构图和密度，还要求筛选／排序后的图片身份、键盘焦点和查看后返回位置可理解。它已有最短列分配、虚拟化、尺寸估计、稳定项身份和滚动恢复接口，适合利用库内图片宽高预先安排完整构图；无需自行编写瀑布流布局算法。焦点管理仍是产品职责。它是 headless 库，卡片样式、容器宽度到列数的转换、选择与键盘焦点仍由产品承担。这个推荐基于 API 与源码匹配程度，不是已测出的性能排名。[官方瀑布流示例][t-example]、[固定版本 API][t-api]、[布局实现][t-core]。

`@virtuoso.dev/masonry` 可作为现成组件对照；其公开 API 缺少本任务需要的身份及恢复入口，因此不因同属 Virtuoso 就直接接替 VirtuosoGrid。不要把列表／Message List 的功能或许可套到 Masonry 包。

## 三个候选

| 候选与发布证据 | 可以复用 | 需要验证／补足 |
|---|---|---|
| **TanStack React Virtual 3.14.13**，依赖 virtual-core 3.17.11；MIT；2026-09-14 发布。源码固定 `78371e851e90fd74e984deeb0c3fd8098e2cd4f3` | `lanes` 最短列布局；逐项 `estimateSize`；`getItemKey`；ResizeObserver 测量；`measure()`；`scrollToIndex`；`takeSnapshot()`／`initialMeasurementsCache`＋`initialOffset`。peer 明确包含 React／DOM 19，包自带 TS 类型。[发布元数据][t-npm]、[包清单][t-package] | 需提供绝对定位样式、列宽和列数。宽度变了但列数没变时，不能只换估高闭包；明确失效旧测量并恢复图片 ID 锚点。筛选／排序变化也需更新身份映射及布局状态。源码已修复改列数的旧 lane 缓存问题，但这不证明视觉锚点保留。[API][t-api]、[实现][t-core]、[变更记录][t-changes] |
| **Virtuoso Masonry 1.4.3**；独立包 `@virtuoso.dev/masonry`；MIT；2026-03-25 发布。固定源码 `b2a02d01de488dbf1e747c7a91151eeca6e13c72` 的包版本仍为 1.4.3 | 可变高度测量、动态列数、元素／窗口滚动、虚拟化；React／DOM peer 包含 19，自带泛型 TS 类型。按滚动即时分列，官方明确快速滚动可能看到分配过程。[发布元数据][v-npm]、[包清单][v-package]、[官方说明][v-doc] | 发布类型仅给出 data、columnCount、ItemContent、context 等；没有 computeItemKey、逐项估高、scrollToIndex 或状态快照，ref 类型为空。源码外层 item key 为 index，DOM 先列再列内项；改列时重新分配已测高度，未见图片锚点保护。排序、删项、切库、焦点与详情返回需实测，不能靠子组件内再写 key 证明外层缓存正确。[发布类型][v-types]、[组件][v-component]、[分列状态][v-size] |
| **Masonic 4.1.0**；MIT；2025-04-22 发布，默认 main 最新提交也是该发布 `308fce2904cfe79cc8d514aca9c4eafc73536348`，不能由此断言项目已停止维护 | 自适应列宽／列数、ResizeObserver、虚拟化、`itemKey`、`scrollToIndex`；默认支持 window 滚动，内嵌滚动可用 hooks 接入。peer 为 React≥16.8，附 TS 类型。[发布元数据][m-npm]、[固定 README][m-readme] | 位置缓存按 index；源码明确缩短／改变 items 时须重建 positioner 或重挂载，稳定 React key 不自动修复几何缓存。发布类型仍用全局 `JSX.Element`／`JSX.IntrinsicElements`，React 19 类型改为 React.JSX，组合编译存在需验证的风险。[positioner][m-positioner]、[渲染实现][m-render]、[发布类型][m-types]、[React 官方迁移说明][react19] |

Masonic 对静态展示确实比 headless 接入短；加入筛选、重排与内嵌滚动后，仍需维护 positioner 失效、锚点和焦点，再验证 React 19 类型，不能据开箱代码量断言总自研更少。

发布范围与类型声明只是兼容证据，三者均未在 Kinshoko 的 React 19／Vite／Tauri／WebView2 组合构建运行。Masonic 的“万张流畅”等 README 宣传不作为本项目测试结果。

## 完整构图、顺序与返回位置

图片宽高使用**方向修正后的显示尺寸**，预留自然比例空间，缩略图完整展示；不要靠 cover 裁切提高密度。极端长图若采用高度上限，只能等比缩小并保留全图，空间效率另测。透明图保留 alpha，背景应让边缘可辨。

逻辑排序、图片 ID、选择和焦点独立于所在列。TanStack 默认 range 按 index 升序返回，可按此生成 DOM；Masonry 的视觉相邻项未必是下一逻辑项，图库仍需明确键盘规则。Virtuoso Masonry 按列嵌套 DOM，默认 Tab 顺序会受列顺序影响；任何候选均未代产品实现完整键盘操作。[TanStack 默认枚举][t-core]、[Virtuoso DOM][v-component]、[Masonic 公共渲染接口][m-render]。

同一结果集与列宽下可验证 TanStack 的尺寸快照＋offset；改宽、换排序或换库后，旧几何快照不能直接套用，需以图片 ID 与图内偏移回到相应位置，目标已不在结果集时明确处理。照片尺寸已知时仍要检查缩略图加载、错误提示是否改变卡片高度。[快照和重测 API][t-api]。

## demo 必须回答的问题

- 混合竖图、横图、方图、极长图、极宽图、透明图、小图与失败图：都完整展示，原比例不变；单独记录图片实际占用的空间比例。
- 改窗口、开合侧栏、调缩略图密度、跨不同 DPI 显示器：列数与缩略图目标像素正确，当前参考不会丢失，清晰度及加载跳动可比较。
- 排序、过滤、追加导入、删除、切库、查看后返回：身份／选择不串图，滚动位置与焦点可恢复；测试键盘、Tab 顺序及虚拟项卸载。
- 分规模构造图库，记录已挂载 DOM、缩略图请求／解码任务、总内存、滚动与回收。TanStack 多列仍为全量几何缓存，默认可见 range 是覆盖各列的连续 index 区间；极端高度差可能扩大 DOM，不能把“虚拟化”当作固定工作量保证。[源码][t-core]。
- 同图同宽对照等尺寸网格，只作为比较基准，不能替代瀑布流交付；画师判断辨认、寻找与返回参考是否更容易。**空间更密不等于找参考更快**，阈值留给验收样本与指标。

## 原生 CSS 的边界

Microsoft 当前 Grid Lanes 示例仍要求在 Chromium 浏览器 flags 中开启特性；旧 `display:masonry` 文档也标明语法已过时。当前未验证目标 WebView2 Runtime 的默认支持，不把原生 CSS 当首个 demo 的唯一实现。CSS 布局本身也不提供本项目的 DOM 虚拟化、身份、焦点或返回位置。[Microsoft 官方示例][css-lanes]、[Chrome 官方说明][css-old]。

[t-npm]: https://registry.npmjs.org/@tanstack%2Freact-virtual
[t-package]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/react-virtual/package.json
[t-example]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/examples/react/variable/src/main.tsx
[t-api]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/docs/api/virtualizer.md
[t-core]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/virtual-core/src/index.ts
[t-changes]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/virtual-core/CHANGELOG.md
[v-npm]: https://registry.npmjs.org/@virtuoso.dev%2Fmasonry
[v-package]: https://github.com/petyosi/react-virtuoso/blob/b2a02d01de488dbf1e747c7a91151eeca6e13c72/packages/masonry/package.json
[v-doc]: https://virtuoso.dev/masonry/
[v-types]: https://unpkg.com/@virtuoso.dev/masonry@1.4.3/dist/index.d.ts
[v-component]: https://github.com/petyosi/react-virtuoso/blob/b2a02d01de488dbf1e747c7a91151eeca6e13c72/packages/masonry/src/VirtuosoMasonry.tsx
[v-size]: https://github.com/petyosi/react-virtuoso/blob/b2a02d01de488dbf1e747c7a91151eeca6e13c72/packages/masonry/src/masonry-sizes.ts
[m-npm]: https://registry.npmjs.org/masonic
[m-readme]: https://github.com/jaredLunde/masonic/blob/308fce2904cfe79cc8d514aca9c4eafc73536348/README.md
[m-positioner]: https://github.com/jaredLunde/masonic/blob/308fce2904cfe79cc8d514aca9c4eafc73536348/src/use-positioner.ts
[m-render]: https://github.com/jaredLunde/masonic/blob/308fce2904cfe79cc8d514aca9c4eafc73536348/src/use-masonry.tsx
[m-types]: https://unpkg.com/masonic@4.1.0/types/use-masonry.d.ts
[react19]: https://react.dev/blog/2024/04/25/react-19-upgrade-guide#the-jsx-namespace-in-typescript
[css-lanes]: https://microsoftedge.github.io/Demos/css-masonry/
[css-old]: https://developer.chrome.com/blog/masonry-update
