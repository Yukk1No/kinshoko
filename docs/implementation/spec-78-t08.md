# #78 T08：各资料库独立目录与查找范围

本单承接 #87，对应 #78 故事 6、7、8。实现起点为集成提交 `71e635dabe38ff4e7ef55695088addd8bfa9881b`。不修改 #42、PR #71 或其历史验收记录。

## 实现

- `Workspace::directories` 返回每个已登记资料库的完整目录树。资料库与文件夹分别保留身份。同名资料库显示路径，目录不会按名称合并。
- `BrowseScope::Folder` 保持直接层级语义。新增 `FolderTree` 表示包含全部子目录，`Unassigned` 表示本库未归类图片。两种目录查询共用 Rust 范围解释器，先按每份来源完整匹配，再按文件字节身份聚合。
- 正式侧栏一次显示全部资料库根。默认包含子文件夹，并提供明确开关。所选开关在后续目录选择中保留。浏览不切换活动写入资料库。
- 文件夹整理继续使用带明确资料库身份的既有动作。当前活动库可新建、改名、移动目录；其他库本单保持只读。未激活库写入由 T09 承接，不通过自动切库绕过。
- 断连库显示原因并禁用旧目录控件。失效文件夹或移除的资料库保留当前范围身份，不静默改为全部资料库。迟到目录响应不覆盖新代次；读取中修订变化会自动重读。
- 全部目录计数、未归类计数和查询结果沿用 T07 全来源成人内容否决。范围之外、未匹配或断连的已知成人来源仍可隐藏同一文件。
- Tauri `workspace_directories` 同时登记在 handler 与 `build.rs`，沿用主窗口 `library:default` capability。核心动作不依赖 Tauri。

## 原型来源

直接参考 `prototype/spec78-alignment/folder-workspace.html` 的 `renderTree`、`folderRows`、`contained`、`folderRecords`、`fw-descendants` 与路径提示。正式界面适配其按库分根、完整层级、未归类与后代开关；数据来自 Rust 真实 provider。

继续复用 T01 恢复的认可 `prototype/reference-browser` 浏览布局。两份固定原型保持原文。原型不作为存储或正式程序验证证据。

## 目录修订与兼容

追加迁移 `0087_folder_revision.sql`。新建、改名、重排、移动或删除文件夹时增加列表修订号，让旧目录状态和分页失效。未修改既有迁移。

该迁移升级内容库格式。旧程序不能直接打开升级后的资料库。回退需要升级前的备份，或使用兼容的新程序。只读旧格式 provider 继续显示需要升级的明确原因，不暗中升级。

## 自动检查

产品源码：`a2db11ef221ad454511c916732acaa5153e36634`。构建树：`d31e4c336a02b162f522245e7ca43c5733cbaada`。

- 6 项本单核心公开行为测试通过。使用真实 SQLite 与图片文件，验证同名森林、直接/含后代范围、多归属、原图路径和字节不变、失效范围、结构修订、移动后旧游标拒绝，以及断连重启后的全来源安全规则。
- 完整 Rust 工作区：578 passed，0 failed，7 ignored。6 个 ignored 为既有父测试执行的故障注入子进程入口；1 个为既有大型性能测试。本单未重跑该性能门槛。
- 严格 `cargo clippy --workspace --all-targets -j2 -- -D warnings` 通过。`cargo fmt` 通过。
- 完整前端：29 文件、235 项通过。包含本单 4 项目录界面检查。TypeScript 与 Vite 构建通过。
- RED 证据：目录新建未改变修订、含子目录接口缺失、断连范围被当作成功空查询、正式森林请求缺失、目录过期未自动重读。原始日志保存在本单 evidence 目录。

每次检查使用本树独立 target，Cargo jobs=2。没有共享其他工作树的 workspace 编译产物。

## 正式原生验证

独立 Windows 11 试件已构建，尚待桌面预约执行。identifier 为 `dev.kinshoko.spec78t08test`；driver 4558/4559；独立应用数据与 WebView 数据；跳过系统自启。

二进制 SHA256：`7E27C4359898600C2E6E0C6055B6CCF752BD50E520AB7235A2E5618DBA96BB7C`。

构建类型为 debug + `tauri/custom-protocol`，使用正式嵌入资源和正式 IPC。它不代表 release 性能或颜色硬件验收。[构建清单](evidence/spec78-t08/native-source.json) 记录产品来源与驱动哈希。脚本为 `e2e/workspace-folders.mjs`。

## 未验证

原生目录操作等待预约。开发者主观体验、Windows 10、多显示器/实际系统 DPI、触笔与广色域硬件检查未验证。负责人已确认目前没有 Windows 10 验证设备，保留未验证状态。

#78 全增量组合验收与真实公开签名自动更新由 T20/T21 分别承接。本单不替代这些验收。
