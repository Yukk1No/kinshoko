# 参考工作区：文档证据

对象为 prototype/reference-workspace。按普通视觉扩展记录：交互拓扑重新组织，现有视觉世界延续；根设计系统不重写。本次只写 DESIGN-NOTES.md 与本文，没有修改 UI、代码、领域术语或 ADR。

| 核对项 | 实际证据与结论 |
| --- | --- |
| 产品与关系 | 读取根 PRODUCT.md、GLOSSARY.md、docs/agents/domain.md、ADR 0002 及表面合同；资料库持有原图／元数据，参考组独立、跨库保存引用和布局。 |
| 现有系统 | 读取根 DESIGN.md、.impeccable/design.json、library-browser/src/styles.css 的 token／导航／控件样式；与本表面 src/styles.css 对照。深浅两套 canvas、chrome、panel、ink、secondary、line、accent、selected-ink、active、hover、image-ground、warning 均同值。字体栈相同，炭灰／浅灰与橄榄色角色继承。 |
| 组件与动效 | 核对 App.tsx 的 Lucide 导入、图标轨、搜索、标签、托盘和分段控件，以及 styles.css 的按钮／焦点状态：常规 34px 控件、8px 控件圆角、6px 标签、2px 强调色焦点与 3px 偏移沿用；当前颜色过渡为 180ms ease-out，减少动画媒体查询关闭过渡。 |
| 查找与复用 | 核对 data.ts 的 libraryId／folderIds、matches、cloneMembers，以及 App.tsx 的共享状态、addReference、saveName、openGroup：查找条件与参考成员分别保存，组只存引用和各成员的范围／布局，不复制原图。 |
| 图片几何 | 核对 Masonry.tsx 的按比例高度、Virtual lanes 与间距；App.tsx 关闭等尺寸与长图裁切。CropEditor.tsx 的等比整图、归一化范围和 CropPicture 预览；ReferenceBoard.tsx 的等比显示、移动／尺寸／锁定，未提供修改裁切边界的控件。 |
| 响应式与修正 | 核对 styles.css 的 1000px／720px 布局、可滚动取用面板；ReferenceBoard.tsx 以成员 ID 保持 DOM 顺序、成员数组决定层级；App.tsx 仅在找图背景处理方案方向键。运行操作证据另见 verification.md。 |

已逐一目视检查当前磁盘的 12 张截图：

| 截图 | 核对的可见内容 |
| --- | --- |
| desktop-A.jpg、user-1351-A.jpg | 深色图标轨、来源分类、三阶段入口、自然比例瀑布流。 |
| desktop-B-light.jpg | 浅色同名色角色，图片墙与下方整图／局部托盘。 |
| desktop-C.jpg | 图片墙与参考区并排，源图与取用后的窗口明确分区。 |
| mobile-A.jpg、mobile-B-light.jpg、mobile-C.jpg、user-553-A.jpg | 窄屏两列图片墙，分类入口、A 阶段／B 托盘／C 任务分段仍可见。 |
| desktop-crop.jpg、mobile-crop.jpg | 30／20／40／35 范围，384 × 376 预览；手机滚动后范围、预览及加入操作可见。 |
| desktop-board.jpg、mobile-board.jpg | 完整参考区、原比例整图和局部；桌面海浪位置锁定与细线窗口，手机可见三个已取用参考及窗口控件。 |

上述文件来自当前同一修正构建。确认 desktop-board.jpg 为 69,882 字节，desktop-crop.jpg 为 76,100 字节，避免把此前同名旧图当作本次证据。静态截图不证明动效或点击行为，相关判断同时对照源码与 verification.md 的操作记录。已读取 verdict.md：两项修正均为 resolved，disposition 为 ship；范围只覆盖窗口首次控制点击与方案快捷键上下文。本次文档核对不替代整表面评审或画师试用。

相对根记录，本表面的继承基准为 13px（旧为 14px）、图卡圆角为 8px（旧为 12px）、颜色过渡用 ease-out（旧为 cubic-bezier(.16, 1, .3, 1)）；这些是局部事实，不是新增系统规范。根文档的 A／B／C 属于旧 library-browser，不能套用为本次结构定义。没有可精确引用的历史 context 漂移条目，本次不推断、不运行 context／doctor，也不修复旧资料。

根文件写前与写后 SHA-256 已核对相同，字节保持：

- DESIGN.md：4665DB964E3C6B4500FF4702F8B93415737C74F7BAC7BFB8308B0AA8273560DB
- .impeccable/design.json：46D8E9D6CB25D7DD578169CC44CFABAF02B021F5DBE0BA4368774041530F4B35

保留边界：内存状态、刷新重置；公开作品的人工示例标签；网页内模拟置顶；无正式 Tauri／持久存储决策，无新增 ADR，无生产性能或自动打标准确率结论。

输出：prototype/reference-workspace/DESIGN-NOTES.md；.impeccable/review/reference-workspace/documentation.md。
