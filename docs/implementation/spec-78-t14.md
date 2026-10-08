# #78 T14 — Eagle 重导与永久删除选择

对应故事：38、39、40；执行工单：#93。
代码基线：`35cafbb90ed5d06432fcb7b49f8b539a2f421162`。
实施分支：`codex/spec-78-t14`。

## 已确认的验证边界

沿用 #78 Testing Decisions 与本次 implement-spec 授权：核心 `Library` 公开导入、整理、永久删除动作，临时目录中的真 Eagle 样本、SQLite 与原图；正式向导和真实 WebView2 的端到端操作。测试只通过公开动作观察结果，不查询私有表或内部调用。

## 执行记录

- 2026-10-08：确认干净工作树，创建独立分支。保留此工作树既有忽略文件、原生报告及构建产物。
- 当前状态：实现及验证进行中。历史 T16 / #42 / #71 的成功不作为本单证据。

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
- 原生检查尚未执行；已准备 `e2e/eagle-deletion-choice.mjs`，待合并最新集成并构建独立 identifier 后执行。
