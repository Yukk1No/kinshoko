# #78 T07：安全的跨库聚合查询（#86）

本单覆盖故事 5、9、10、11、16、44。同一现有工作区默认查找全部可用的已登记资料库；每份来源先独立满足整条查询，再按文件 SHA256 聚合。浏览范围与活动写入资料库分别保存。不可用提供方有明确状态和原因。

实现从 `8af63b5934e8467629da0ba8d42f7a75daf50091` 开始，复用已结束的 T01 树并建立 `codex/spec-78-t07`。主要实现为 `22c60f2`；安全快照和词表缓存为 `0da9422`；删除详情生命周期修复为 `7e5cd98`；启动视角补充修复为 `43a465a`。已合入 T14 `20bded0`、T03 `ed863ee`，并合入最新集成 `7599a9f`（本次仅补充实施文档）。没有改写 #42／#71 或其历史验收，也未操作 GitHub、推送、发布或生产密钥。

## 核心与正式接入

公开入口为 [`Workspace`](../../crates/kinshoko-core/src/workspace.rs)，输入 `WorkspaceQuery`、`WorkspaceScope`、现有 `ConditionTree` 与安全模式。返回稳定文件身份卡片、全部已知来源、分页游标、去重计数和修订状态。`status`、`resolve`、`candidates`、`sidebar`、`contains`、`local_tags`、`tag_groups` 为后续工单提供独立读取与投影接缝。

- 提供方使用 `DeviceLibraries::read` 的隔离只读句柄，包括活动库。查询不激活资料库、不修改活动库安全模式、不写入库内分级。现有核心 SQL 条件解释器执行完整来源查询。
- 统一身份先翻译成提供方本地 ID。一个身份在同库对应多个本地 ID 时为 OR；不同 all 条件保持 AND。缺失的包含标签为 false；任一、排除、否定空分组和明确空分组保留原结构。文字项继续使用现有核心 Search 和 Library 文字语义。
- 卡片的 `sources` 包括不匹配、范围外、回收站与已知离线来源。没有可用匹配来源时不显示卡片；相似而字节不同的文件不聚合。来源选择只决定实际详情和图片读取，不改变写目标。
- 任一已知来源的有效分级为 Adult，会隐藏整张卡片，即使该来源不在范围内或不匹配。未知分级继续可见。安全候选和计数按同一文件身份封印后去重。
- **保守断连解释**：此前已读到的 Adult 来源断连后继续否决同文件，重启也保留；重新读到该提供方的新事实，或明确取消其登记后才撤销。应用 `workspace.sqlite` 只缓存文件身份、来源、安全与尺寸事实；离线词表、名称、别名和标签成员不缓存供查找使用。
- 注册状态、各提供方 list/vocabulary 修订、目录修订和模式共同使请求与游标失效。命令及图片协议在响应边界重新授权；前端按请求代次丢弃旧成功和旧错误。独立 `workspace-changed` 监测读取提供方修订，不依赖活动库事件，间隔 1.5 秒。活动库原有事件仍使当前操作立即刷新。

[`workspace` Tauri 适配层](../../src-tauri/src/library/workspace.rs) 转发以上核心动作。八个新增命令同时登记于 handler、`build.rs` inline-plugin command 列表和现有 `library:default` capability；正式原生验证调用真实命令许可。

共享名称只复用 T03 的 `CatalogInspection::search_vocabulary`。`CatalogTag.names` 为已解析名称，默认与偏好元数据仍独立；Pending 保持原主要显示，显式选择采用共享规则。本单仅对这一投影增加等价索引，没有复制偏好逻辑。

## 复用来源与范围

正式 App、Rail、ContextSidebar、Wall、密度滑块和 Viewer 基于 T01 接入的认可 `prototype/reference-browser` 代码。读取并改编 `prototype/spec78-alignment/library-workspace.html` 的同工作区资料库范围按钮、来源清单与显式来源查看交互，接入正式 [`WorkspacePane`](../../src/library/WorkspacePane.tsx)、App 和 Wall。保留布局、圆角、密度、稳定锚点、单击查看及 Esc 返回。原生检查确认查看非活动来源不切换资料库，Esc 保持墙位置。

目录树目前读取所选提供方（全部范围时显示活动提供方树）；T08 的完整独立目录森林与子目录范围没有宣称完成。现有库内分组只做统一身份兼容投影，T05 全局存储另行接入。工作区不把个人近似写入某个隐含来源，T06 全局规则另行接入；内置展开和本次排除仍使用 Search。T09 的完整来源整理／删除／钉图动作和 T10 的显式写目标没有宣称完成。聚合来源不明确时不自动出现隐含写入选择。T14 导入报告的回收站入口明确指向活动导入库，并打开浏览面板、清掉旧搜索。

## 有界读取与旧格式

不可变安全快照按登记、提供方和目录修订复用；命中时只核对提供方元数据，不再重新扫描全库或写缓存。图片授权查已建立的文件身份索引；一轮目录计数共用同一安全快照。候选先一次遍历有效标签成员建立 tag→可见 hash 集合，再使用 local→global 索引构建；安全／非安全词表在该修订内分别懒缓存，避免词表×图片遍历及每次打字重建。共享名称投影也使用映射与定义索引。

真实公开动作样本包含 2 库、96 来源、48 文件身份和 12 个目录。合入 T03/T14 后记录 browse 80 ms、sidebar 18 ms、48 次授权 530 ms。具体输出见 [核心记录](evidence/spec78-t07/core-green.txt)。这些是本机小样本结果，不代表大库 100 ms 门槛通过。

在 `22c60f248915329e4bf85dcfb38633210190f558` 用公开核心动作创建实际旧格式两库和 PNG，随后合入 T14 新迁移。正式新版启动时，活动库走正常可写升级；另一个 detached 旧库明确显示“资料库需要先在 Kinshoko 中打开一次以完成升级”。没有把它当空库，也没有在只读路径升级。旧库 `library.sqlite` 读前后 SHA256 均为 `80077177b7cb90bca0d9e9e70f555436e5f99792fd0844771150ac175b007fdb`。真实旧／新版安装升级由 T19 独立记录。

## RED → GREEN 与验证

新增核心测试使用公开动作、真实 SQLite 库与实际 PNG 文件，没有私表内容或内部调用次数断言。前端受控 IPC 仅补充请求生命周期和 UI 视角边界。旧单库测试使用明确的测试适配器继续验证原有交互，实际跨库语义由核心和原生检查负责。

| 场景 | 观察到的 RED | GREEN |
| --- | --- | --- |
| 每来源完整匹配后聚合 | 新 workspace 公共入口不存在 | 真实两库公开动作 |
| 显式空 any 分组 | 错误返回 1 张，预期 0 | 核心 Search 与完整查询保留 false |
| 永久删除迟到详情 | 已进入删除确认，旧请求仍写入缺失错误 | 删除确认结束详情／标签视角；当前有效请求错误仍可见 |
| 关闭安全模式、活动库断连后启动 | 可用库的工作区被建库页隐藏 | 按实际模式重读登记状态并作废旧回复 |

红绿原件见 [入口 RED](evidence/spec78-t07/core-red.txt)、[空分组 RED](evidence/spec78-t07/empty-group-red.txt)、[删除 RED](evidence/spec78-t07/delete-lifecycle-red.txt)、[删除 GREEN](evidence/spec78-t07/delete-lifecycle-green.txt)、[启动 RED](evidence/spec78-t07/bootstrap-red.txt)、[启动 GREEN](evidence/spec78-t07/bootstrap-green.txt)。

- Rust workspace：570 通过，7 个既有子进程／受控环境辅助测试保持 ignored；没有把 ignored 计为通过。
- 公开新 workspace：7 项；合并兼容名称 8 项、目录身份 11 项；多目录耗时见输出。
- 最终前端：28 文件、231 项通过；TypeScript、Vite 正式构建、`cargo fmt` 和严格 `cargo clippy --workspace --all-targets -- -D warnings` 通过。
- Windows 11 专业版 build 26300；各树独立 Cargo target，jobs=2。原生 identifier `dev.kinshoko.spec78t07test`，driver 4450/4451，独立应用数据及 WebView 数据，跳过系统自启登记。

正式原生产品源码为 `7e5cd98ab760181e610f1689dc211209162d3c78`，二进制 SHA256 为 `9f5846e559b69160eb1725accd2f4792f59c406e4bda23a5e3fe65533df59bc3`。本次保留该通过二进制，后续构建不覆盖这份证据。完整 [源码与哈希清单](evidence/spec78-t07/native-source.json)、[工作区结果](evidence/spec78-t07/native-result.json)、[删除结果](evidence/spec78-t07/native-delete-result.json) 和日志均落盘。

[`e2e/workspace.mjs`](../../e2e/workspace.mjs) 在正式程序通过 25 项：默认全部提供方、旧格式明确不可用、按字节聚合、未知分级、无 split-tag、全部来源、范围与活动写目标独立、非活动来源图片和详情、Esc 位置、分页、旧模式游标与候选拒绝、范围外 Adult 否决、安全候选、分级刷新、断连重启持久否决及显式取消登记。使用真实创建／导入／整理动作，不使用页面 mock 或私表写入。

[`e2e/workspace-delete.mjs`](../../e2e/workspace-delete.mjs) 使用同一二进制追加 2 项正式检查：永久删除所选图后没有遗留“资料库中没有这张参考图”提示；新的详情读取明确失败。T14 发现记录原件保留，修复与补验由本单单独记录。两轮应用和驱动均已确认退出，并明确释放桌面给 T19。

最后的启动视角修复 `43a465a` 在释放桌面后发现，已由公开 UI RED→GREEN、完整前端回归和正式构建验证。最终隔离原生构建也已通过（源码 `43a465a5eb8587884b84d184dc8e693c14728793`，SHA256 `057744877bab34be6f1ef8ac0d5c293def9c9800eef8d1917c4e898c3ce9816e`；[清单](evidence/spec78-t07/final-build-source.json)）。上述 27 项原生证据不冒称覆盖这一个后加启动分支；它的原生启动补验仍待下次预约／T20。

未执行的开发者主观真机验收、Windows 10、多显示器／跨 DPI、触笔与广色域硬件检查保持未验证。现有 Windows 11 自动化不替代这些项目。#78 全增量组合验收与公开签名更新也没有由本单判定通过。
