# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

用户希望采用 Tauri，先评估 Tauri 2 的 Windows 适配。React／TypeScript／Vite 和 Rust 侧存取是[实现提案](docs/discovery/first-production-feature-plan.md)中的候选，尚未构建验收或确定正式组合。上述平台值描述前端设计语言；交付目标为 Windows 桌面软件。

## Users

二次元画师。首位验收者为发起者的画师伴侣，使用自己的参考图辅助绘画。

## Product Purpose

缩短从收集素材、按发色或发型等条件找到参考，到查看整图／局部并在绘画桌面使用的流程。优秀局部可以组成参考组，以后整体复用。

## Operating Context

Windows、单人、本地优先。无独显电脑也能完成核心流程，GPU 用于加速。公开／自制素材及构造的 Eagle 样本先验；覆盖不足时可补画师的小批真实素材。

## Capabilities and Constraints

- 用户可独立建立多个资料库；原图及其元数据属于资料库，原字节保留。参考组独立保存，可引用多个库；定义与关系以[领域文档 PR](https://github.com/Yukk1No/kinshoko/pull/2)为准。
- 标签／文字帮助找到候选参考，人工整理保留。先支持 Eagle 迁入，之后独立管理；持续接入另行规划。
- 原图与局部参考应清晰显示；桌面钉图展示预先选定的局部，桌面上不修改裁切边界。
- 首个长期使用版本必须交付经过恢复验证的本地备份。远端备份、持续多设备同步、超分和高级检索在 roadmap 中展开。
- 当前首个正式功能范围仍是待评审提案：建立／打开、静态图导入、浏览／清晰查看、关闭后重开。
- 用户已要求在界面 demo 中实现瀑布流，验证图片空间利用；是否作为正式布局及具体组件仍需运行证据。

## Brand Commitments

项目暂名 Kinshoko。用户已指定图标组成的侧栏，并以 Axolotl Launcher 的侧栏、动画与视觉效果作为参考；这项参考不自动确定正式框架、具体配色或所有窗口材质。

## Evidence on Hand

[领域共识及数据提案](https://github.com/Yukk1No/kinshoko/blob/90bef426bf0899f0341c3f407574826aa0ad794c/docs/discovery/alignment.md)、[技术提案](docs/discovery/first-production-feature-plan.md)、[Axolotl 固定源码核查](docs/research/axolotl-interface-reference.md)、[瀑布流依赖核查](docs/research/masonry-grid-reuse.md)。当前尚无应用运行、真实素材检索耗时、画质或恢复测试结果。

## Product Principles

- 以画师完成参考任务所需的时间与操作衡量功能。
- 清晰观察图片，保留原文件与人工整理。
- 素材可备份、可恢复、可迁移。
