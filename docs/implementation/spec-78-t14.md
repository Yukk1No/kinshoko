# #78 T14 — Eagle 重导与永久删除选择

对应故事：38、39、40；执行工单：#93。
代码基线：`35cafbb90ed5d06432fcb7b49f8b539a2f421162`。
实施分支：`codex/spec-78-t14`。

## 已确认的验证边界

沿用 #78 Testing Decisions 与本次 implement-spec 授权：核心 `Library` 公开导入、整理、永久删除动作，临时目录中的真 Eagle 样本、SQLite 与原图；正式向导和真实 WebView2 的端到端操作。测试只通过公开动作观察结果，不查询私有表或内部调用。

## 执行记录

- 2026-10-08：确认干净工作树，创建独立分支。保留此工作树既有忽略文件、原生报告及构建产物。
- 当前状态：实现完成，核心、界面与真实 WebView2 验证通过。历史 T16 / #42 / #71 的成功不作为本单证据。

### TDD 记录

1. `permanently_deleted_eagle_content_stays_skipped_after_restart_in_this_library_only`：修改生产代码前运行失败，实际 `imported`、预期 `skippedDeleted`。增加同事务内容哈希记忆和导入检查后通过（1/1）。

2. `allowing_one_import_keeps_the_memory_but_allows_normal_refresh_until_deleted_again`：先因缺少 `import_with_options` / `ImportOptions` 编译失败；实现单任务选项后通过（2/2），明确允许后正常刷新保留本库备注与文件夹，再次永久删除与重开后仍跳过。

3. `trash_duplicates_offer_the_existing_image_without_restoring_it`：修改前实际 `refreshed`、预期 `trashDuplicate`；新增明确回执后通过（3/3）。只在原有图已经处于回收站时产生该回执，首次迁入 Eagle 回收站保持原有语义。

4. `eagle_choice_preflight_recognizes_selected_parent_and_item_without_registering_a_source`：先因缺少公开 `contains_eagle` 编译失败；实现只读目录识别后通过（4/4）；同批核心单元与绑定生成 141/141 通过。
5. 追加内容版本、失败重试与删除提交后故障恢复行为检查。内容版本检查不需要进一步生产代码修改，验证已实现的哈希边界。

6. 新规格明确“已有目标资料库回收站副本不自动恢复”。保留同一任务中新建同字节 Eagle 条目共同决定初始状态的行为，限定为本任务创建且仍有 Eagle 初始删除标记的图；人工删除始终优先。`a_live_duplicate_never_restores_initial_eagle_trash_created_in_a_previous_task` 先复现自动恢复，再实现任务内创建集合后通过。更新旧的跨任务／重启恢复断言，旧报告与工单正文不改。
7. `permanent_delete_respects_an_interrupted_allowed_imports_pending_original_then_recovers` 先失败：永久删除遇到 pending 时保留了原图但丢弃待清除记录，重开留下原图。修复为只有 pending 引用时保留清除记录，活图已引用时才取消清除。只经公开动作与原图文件观察，不查询私有表。

## 行为与兼容

- `Library::import` / 原有 `ImportSource { paths }` 保持默认入口；新增 `import_with_options` 固定单次任务策略，Tauri 命令中的 options 可省略。
- 目标资料库的永久删除按 SHA-256 内容版本记忆。相同 Eagle 条目换新字节可以导入；旧字节重新出现仍跳过。允许一次不会移除记忆，活图之后正常刷新。
- 删除记忆随本次迁移开始记录；此前已经永久删除且没有记录的历史内容无法追溯。
- `ImportSource::contains_eagle` 只读预检涵盖 Eagle 库、条目和父文件夹，不解码原图，不登记或刷新来源。取消向导不会开始导入。
- 已有回收站内容（包括此前 Eagle 初始回收站副本）不会被新的活条目自动恢复。仅同一任务中新建且未被人工删除的图可以由同批活 Eagle 条目决定初始状态。取消、失败重试和重启都开始新任务。
- `trashDuplicate` 回执只显示通用提示，不列具体数量或文件名；入口进入现有受安全模式筛选的回收站。恢复仍由画师执行。
- 失败重试与搬家确认保留原任务的本次选择；新选择默认跳过。

## 本单检查（集成前）

- `cargo test -p kinshoko-core --test eagle_deleted_content --test eagle_reimport --test eagle_import --test eagle_crash --test permanent_delete --locked -j2`：46 项通过，4 个仅子进程故障注入入口按设计忽略；子进程实际由父测试执行。
- `npm run typecheck`：通过。
- `npm test -- src/library/ImportBar.test.tsx src/App.test.tsx`：57 项通过。既有 Eagle 入口测试更新为确认新增策略步骤；启动失败时保留当前选择继续重试。
- 当时尚未执行原生检查；已准备 `e2e/eagle-deletion-choice.mjs`，待合并最新集成并构建独立 identifier 后执行。

## 合并后检查

已合并 `codex/spec-78-integration` 的 T01 前端与 T02 标签目录代码及文档，基于 `0ca342e`。全工作区与前端回归对应 `8190801` 的同一生产实现；之后仅增加预检命令 ACL 许可，并在 `e4966fa` 再次通过严格 lint 及原生验证。

- `cargo test --workspace --locked -j2 -- --test-threads=2`：548 项通过、0 失败、7 忽略。6 个忽略项为父测试实际启动的故障子进程入口，另 1 个为既有大库 100 ms 搜索性能测试，本单未执行该性能测试。
- `npm test`：25 个文件、219 项通过。
- 合并后的 `npm test -- src/library/ImportBar.test.tsx src/App.test.tsx`：62 项通过。
- `npm run typecheck`、`npm run vite:build`：通过。
- `cargo clippy --workspace --all-targets --locked -j2 -- -D warnings`：通过。
- `cargo fmt --all --check`、`git diff --check`、`node --check e2e/eagle-deletion-choice.mjs`：通过。

### 原生验证环境与方法

Windows 11 Professional 26H2，10.0.26300 / 26300.9550；Node 22.15.0、npm 11.12.0、rustc 1.95.0、cargo 1.95.0。真实 WebView2 154.0.4258.62，DPR 1.1041666269302368；主显示器 2560×1440、110%、SDR。机器：Ryzen 7 5800X、31.9 GB、RTX 4070 SUPER。

独立 identifier `dev.kinshoko.spec78t14test`，独立 APPDATA、LOCALAPPDATA、Kinshoko data 与 WebView 目录，4480/4481 端口，`KINSHOKO_SKIP_AUTOSTART=1`。仅用本树 target，`CARGO_BUILD_JOBS=2` / `-j2`，没有共享 `CARGO_TARGET_DIR`。

构建：先 `npm run vite:build`，再带 `TAURI_CONFIG={"identifier":"dev.kinshoko.spec78t14test","productName":"Kinshoko T14 Validation"}` 执行 `cargo build -p kinshoko --features tauri/custom-protocol --locked -j2`。

执行：`node e2e/eagle-deletion-choice.mjs target/debug/kinshoko.exe C:/Users/yuk1no/.codex/worktrees/spec78-t01-frontend/kinshoko/work/e2e/tools/msedgedriver.exe C:/Users/yuk1no/.cargo/bin/tauri-driver.exe`。EdgeDriver 实际采用相邻 T01 树中的匹配版本。脚本用真实 Eagle 文件、目标 SQLite 与原图，经生产向导、WebDriver 原生输入与公开 Library 命令验证；文件选择由已有测试队列替代系统对话框，未操作私人数据。

首次原生 RED：代码 `8190801b87fa999039a016ce052333be6074297c` 可建立真实资料库，但选择含 Eagle 的父目录后实际提示 `library.import_contains_eagle not allowed. Command not found`，无法打开策略步骤。原因是新命令漏入 `src-tauri/build.rs` 内联插件 ACL 清单。提交 `e7f27c7` 补齐清单；失败 HTML、截图、JSON 保留在忽略目录 `work/native/eagle-deletion-choice-acl-red/`。此故障只在真实原生接线中暴露，前端 mock 与 Rust 核心绿灯没有被当作原生通过。
原生最终 GREEN：应用代码 `e7f27c7`（本树独立构建），E2E 脚本 `e4966fafc20295045f05d6719ee45697dc029802`；2026-10-08 23:23 CST 完成，17 项通过、0 失败。脚本修订只把既有标签步骤的关闭动作兼容为“完成／全部跳过”，未改变应用逻辑，未为此重复构建相同应用。

已实际走过：生产 UI 新建隔离资料库 → 含 Eagle 父文件夹预检及默认项 → 取消且目标不变 → 默认首次导入 → UI 软删和永久删除 → 默认同内容跳过 → 从回执重新选择本次允许 → 保留人工备注／文件夹的正常刷新 → 软删后重导保持回收站 → 通用回执进入回收站并由画师恢复 → 再次永久删除 → 真正结束并重启应用 → 记忆仍有效 → 相同 Eagle ID 的新字节可导 → 缺文件失败 → 修复文件、失败重试保持本次允许与来源 → 成功。

最终 JSON：[spec-78-t14-native.json](spec-78-t14-native.json)。抽取截图已逐张查看：[默认选择](evidence/spec78-t14/default-choice.png)、[回收站重复回执](evidence/spec78-t14/trash-duplicate.png)、[失败重试保留选择](evidence/spec78-t14/retry-keeps-choice.png)。ACL 首轮失败 JSON：[spec-78-t14-native-acl-red.json](spec-78-t14-native-acl-red.json)。完整五张成功步骤截图、各次失败截图／HTML／报告与检查日志仍保留在本树忽略目录 `work/native/` 和 `work/t14-checks/`，没有覆盖旧 T16 记录。原生驱动与独立应用已退出，桌面预约已释放。

## 未验证与边界

- 未验证 Windows 10、其他 WebView2 版本、DPI 或物理设备组合；本单不是安装器、签名、发布验证。
- 未操作系统文件选择对话框本体；其返回路径使用既有 E2E 队列替代，之后执行正式预检、向导与导入。
- 既有大库搜索性能测试未执行。故障恢复仅覆盖文中公开测试与已有注入点，不代表任意硬件断电组合。
- 升级前已永久删除的内容无法补建历史记忆。当前 migration 之后的删除会原子记录；记忆仅属于目标资料库，显式允许只作用于本任务。
- 安全模式下回收站重复提示只给通用入口，不增加名称与数量。T15 的本次回执成人预览仍由 T15 独立交付。
- 原生观察：永久删除已选图后出现过非阻塞提示“资料库中没有这张参考图”，截图原样保留。17 项导入、回收站和恢复断言仍全部通过；该旧详情请求／选择清理现象已告知集成负责人及正在修改 App 的 T07，本单未修复或宣称不存在此提示。
