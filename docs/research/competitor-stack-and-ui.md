# 竞品前端栈与首个功能的依赖取舍

调查日期：2026-10-03（Asia/Shanghai）。关联[核查竞品技术栈与首个功能的可复用依赖](https://github.com/Yukk1No/kinshoko/issues/12)。仅核查官方文档、固定源码和 npm 版本元数据；未安装应用、执行性能测试或改变领域决定。下文分别标明源码事实、官方声明与建议；版本是核验基线，不称“最新”。

**建议首切片暂用 Tauri 2 + React + TypeScript + Vite + VirtuosoGrid**，完成创建/打开资料库、导入本地静态图片、浏览缩略图、清晰查看原图、关闭后无损重开。先用等尺寸卡片、自适应列数与 `object-fit: contain`；长宽比由卡片留白承接，减少第一阶段的排版与测量负担。这是工程取舍，尚无证据证明 React 或 Tauri 更快。

## 竞品实际使用什么

| 对象与固定范围 | 可核验实现 | 对 Kinshoko 的启发与边界 |
|---|---|---|
| Monbooru `f49d97e45de899e4413bc5239c4efe3e799fdf2d` | Go 1.26.7、Go HTML 模板、htmx 1.9.12；`modernc.org/sqlite` 1.59.0。[清单][M1]、[模板][M2]、[htmx][M3] | 服务端模板与局部替换是另一种架构；不能据其界面推导 React/Svelte。 |
| Project Curator `f98f0b5c1941185ba781cb51963fefe023d42c42` | Rust/Tauri 2；原生 TS 5.6.3、Vite 6.4.3，Tauri JS API 2.11.1/CLI 2.11.4；清单没有 React/Svelte/虚拟网格库。[前端清单][C1]、[锁文件][C2]、[Rust 清单][C3] | `cards.ts` 用 IntersectionObserver、限量缓存与可见原图切换；卡片追加到 DOM，图片懒加载不等于 DOM 虚拟化。[实现][C4] |
| Hydrus v688 / `e1cbffc2f7d4a64a44cc25345718cde363ef6221` | Python + QtPy 2.4.3/PySide6；Windows 构建清单为 6.9.3，`pyproject` 为 6.10.3，不能据此指定已发布实包版本。[Windows][H1]、[项目清单][H2] | QPainter 按缩略图行/画布页绘制、缓存，并考虑 DPR；可借鉴预算与清晰度处理，Qt 组件不能直接用于 WebView。[实现][H3] |
| Nephele 官方文档（资源库页更新 2026-09-25）；Audit `ccd0711d266a2a5ee0cd2ada9c309e14d2e51e94` | 官方声明创建/连接库、拖入、Ctrl/Shift 选择、双击放大；桌面 GUI 栈未公开。Audit 仅证明安全子集为 Python，不证明桌面使用 React、Qt 或 Tauri。[文档][N1]、[公开范围][N2] | 可对照用户操作；闭源内部图库依赖、缓存与布局实现仍未知。 |

可迁移的是“缩略图与原图分工、可见范围决定工作量、缓存有预算”。Curator 的 Full Images 策略可做对照实验，但首切片先让详情查看按需读原图，避免整屏同时解码大图。Kinshoko 已选择资料库持有原文件，不能把界面加载策略当成存储决定。Monbooru 项目为 AGPL-3.0、Curator 为 MIT、Hydrus 自有代码为 WTFPL v3；复制源码分别需要核对对应义务和第三方许可，本轮只借鉴实践。[许可证][L1]、[许可证][L2]、[许可证][L3]

## 两种前端基线与两种网格依赖

Tauri 官方把前端当静态资源，支持 React/Svelte 等 SPA，并推荐 Vite；发行时不需要 SSR 或常驻前端服务器。[官方配置][A1] React + TS + Vite 与 Svelte + TS + Vite 均可行：本次暂选 React，是因为等尺寸多列网格已有可直接集成的 VirtuosoGrid，能减少基础能力自研；并非竞品使用了 React，也不是运行速度结论。若采用 Svelte，可用官方 TanStack 适配器；组件响应式与生命周期写法需要另一套集成验证。

| 候选（已核对具体 npm 版本） | 能复用的基础能力 | 仍由项目承担的成本 |
|---|---|---|
| `react-virtuoso` 4.18.16 / `b2a02d01de488dbf1e747c7a91151eeca6e13c72`，MIT；React/ReactDOM peer 接受 19 | VirtuosoGrid 支持等尺寸、多项每行；监听容器/卡片尺寸并重算滚动范围。[清单][V1]、[npm][VR]、[规则][V2] | 需给 CSS grid/flex 样式、稳定的自定义组件、选择/焦点和加载状态。它没有提供任意高低卡片的瀑布流解法。 |
| TanStack Virtual：React 3.14.13、Svelte 3.13.39 / `78371e851e90fd74e984deeb0c3fd8098e2cd4f3`，MIT；peer 支持 React 16.8–19、Svelte 3.48/4/5 | headless 轴向虚拟器、测量与滚动能力，两个框架都有官方适配。[React 清单][T1]、[Svelte 清单][T2]、[npm React][TR]、[npm Svelte][TS]、[定位][T3] | 不生成布局；规则网格仍要自行分组行、计算列数与记录索引，并处理窗口改宽后的锚点。当前需求不值得先承担这些适配。 |

维护时需要锁定发行版本、保留 MIT 声明，并在升级后回归尺寸监听、焦点与滚动行为。[Virtuoso 许可][V3]、[TanStack 许可][T4] 现有 peer 范围只证明框架版本允许组合，仍需在 Windows WebView2 上验证。网格组件也不管理资料库身份、导入事务、图片解码或原图清晰度；这些不能靠换框架获得。

原图可通过 Tauri 的 `convertFileSrc` 与限定的 asset scope 加载，需同时配置 CSP；应验证选库、切库、关库时资源范围与旧请求结果的清理。[API 与条件][A2] 前端保存的是显示和交互状态，原文件/元数据归资料库，跨库参考组日后另保存引用、裁切与布局；本轮不选画布、图编辑或全局状态框架。

## 下一步验证门槛（尚未执行）

1. 锁定 React 19 与所选 Tauri 2、TS/Vite 发行版及 Virtuoso 4.18.16，核对 peer、许可、WebView2 与生产构建；竞品锁文件只是证据，不能直接当本项目版本锁。
2. 无独显 Windows 上以 125%/150%/200% 缩放验证横图、竖图、透明 PNG、高像素图；缩略图像素量随显示尺寸/DPR足够，详情可按原像素查看，离屏不持续解码原图。
3. 用 100/1,000/10,000 条记录测滚动、改宽、快速切库；DOM 数量应受可见范围/预渲染约束，反复浏览后缓存不无限增长。记录生产版耗时/峰值内存后再定预算，不预写跑分。
4. 中文/长路径、重复导入、坏图和中断后重开：核对原字节哈希、记录数量及可查看性，并确认旧库响应不进入新库。标签检索、Eagle 迁移、钉图/参考组复用和经过恢复测试的备份属于后续首个可用版本的验收。

[M1]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/go.mod
[M2]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/web/router.go#L123
[M3]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/web/static/htmx.min.js
[C1]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-dashboard/package.json
[C2]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-dashboard/package-lock.json
[C3]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/Cargo.toml
[C4]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-dashboard/src/cards.ts
[H1]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/static/build_files/windows/requirements.txt
[H2]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/pyproject.toml
[H3]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/gui/pages/ClientGUIMediaResultsPanelThumbnails.py#L294
[N1]: https://nephele.arisfusion.com/zh/docs/library
[N2]: https://github.com/CreatorAris/nephele-core-audit/blob/ccd0711d266a2a5ee0cd2ada9c309e14d2e51e94/README.md
[L1]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/LICENSE
[L2]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/LICENSE
[L3]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/LICENSE
[A1]: https://v2.tauri.app/start/frontend/
[A2]: https://v2.tauri.app/reference/javascript/api/namespacecore/#convertfilesrc
[V1]: https://github.com/petyosi/react-virtuoso/blob/b2a02d01de488dbf1e747c7a91151eeca6e13c72/packages/react-virtuoso/package.json
[V2]: https://github.com/petyosi/react-virtuoso/blob/b2a02d01de488dbf1e747c7a91151eeca6e13c72/packages/react-virtuoso/docs/3.virtuoso-grid/grid-responsive-columns.md
[T1]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/react-virtual/package.json
[T2]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/svelte-virtual/package.json
[T3]: https://tanstack.com/virtual/latest/docs/introduction
[VR]: https://registry.npmjs.org/react-virtuoso/4.18.16
[TR]: https://registry.npmjs.org/@tanstack%2Freact-virtual/3.14.13
[TS]: https://registry.npmjs.org/@tanstack%2Fsvelte-virtual/3.13.39
[V3]: https://github.com/petyosi/react-virtuoso/blob/b2a02d01de488dbf1e747c7a91151eeca6e13c72/packages/react-virtuoso/LICENSE
[T4]: https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/LICENSE
