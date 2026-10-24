# #78 T12：资料库内容备份与恢复

关联：[独立规格 #78](https://github.com/Yukk1No/kinshoko/issues/78) 故事 33、35、37；[工单 #91](https://github.com/Yukk1No/kinshoko/issues/91)。本单从集成提交 `e9be4ea11fdd610270936e13e257e600d199d01f` 开始。#42、PR #71、T11 和前置备份记录没有改写。

实现已完成。Windows 11 正式程序的内容备份组合通过 57 项断言。同一冻结程序的 smoke 通过 5 项断言。源码、构建、失败原件、截图范围和释放记录见 [独立证据索引](evidence/spec78-t12/README.md)。Windows 10 保持未验证。

## 内容与设置边界

正式设置入口称为“资料库备份”。它保护原图、逐图整理、目录、关联参考组和标签定义。恢复保留当前程序设置。名称偏好、程序标签分组和个人近似规则由 T13 的独立程序设置备份保护。本单没有增加设置包。

正式界面直接参考认可原型 `prototype/reference-browser/src/components/SettingsDialog.tsx` 的备份区域与范围选择。实现仍连接正式应用的公开动作、SQLite、原图和原生窗口。原型没有充当正式验收结果。

`BackupTarget::run_with_catalog` 复用既有范围重算、SQLite Online Backup、原图租约、增量原图存储、计划和保留策略。应用先取得完整 `CatalogInspection`。内容快照只在私有 SQLite 副本中注入程序当前纯定义。它与 T11 包导出、显式定义发布共用 `CatalogInspection::content_bindings`。来源 provider 不因此发生隐式写入。

快照携带稳定标签 ID、本地标签映射、命名空间、默认名称、别名和外部对应。它不携带用户显示名称偏好。程序纠正或拆分身份、删除别名后，即使来源只读或显式定义发布失败，内容备份仍携带当前定义。封印依赖通过完整原始目录处理，不经过界面安全投影。

快照副本删除旧资料库中的标签分组和个人近似迁移行。旧整库快照恢复时，也只在恢复副本删除这些行。新库 ID 不会让旧迁移设置重新登记或复活。旧来源数据库保持原状。往返检查只比较内容表，并返回实际检查的表数。

`BackupTarget::restore_with_catalog` 在创建恢复目录前核对目标程序已有稳定身份和命名空间。冲突先拒绝，不修改当前内容或设置。恢复生成独立资料库和参考组 ID，记录恢复来源，将组成员指向本批次恢复的库。原图不重新编码。逐图人工标签、拒绝标签、备注、内容分级、目录层级，以及组成员裁剪、翻转、旋转、缩放和布局保留。

已有环境恢复后，当前程序名称偏好、别名删除记忆、全局分组成员、个人近似决策和来源确认记录保持。空白环境从内容定义解释标签，不迁入源程序偏好、全局分组或个人规则。

## 恢复中断与回退

一次恢复先在目标目录的 `.kinshoko-restore-<id>.incomplete` 中准备全部库和组。发布第一个库前，程序在 `reference-groups/restore-transactions/` 持久保存本批次的新身份、目标位置和恢复来源。库和组分别发布。这里没有跨文件系统或跨存储的原子事务。

普通写入错误立即回退本批次。进程在库或组发布阶段中断后，下次程序启动或恢复重试先读取记录。程序核对全部目标的身份、位置和恢复来源，再撤回本批次新库和新组。既有库、既有组和当前设置不属于该记录。目标被用户替换、移动或身份不符时，程序保留现场并报告回退未完成，不删除不明内容。回退成功后可重新执行完整恢复。

核心恢复使用进程级 `RESTORE_GATE`，与同一程序的恢复和启动回退互斥。Tauri 在备份管理器建立时执行回退，主窗口打开前完成。恢复不拿程序目录写锁；所需定义已取得不可变快照。

批次日志保护核心内容发布。完成后的本机资料库登记沿用既有流程，未纳入该日志。因此本单不声称内容、设备登记和程序目录之间存在统一原子提交。

## 公开红灯与回归

公开检查使用 `Library`、`TagCatalog`、`BackupTarget`、`ReferenceGroups`、真实 SQLite 和原文件。失败和通过日志逐字节保存在 [证据目录](evidence/spec78-t12/README.md)。完整数据库、原图、WebView profile 和两份冻结 exe 原件仍在 ignored `work/`，并由根任务另行保存。

- `t12-red-freshness` → `t12-green-freshness`：程序纠正与别名删除后，只读来源发布失败；内容备份仍在空白应用恢复当前身份和纯定义。
- `t12-red-settings-ownership` → `t12-green-settings-ownership`：内容恢复不迁入旧全局分组和个人近似。
- `t12-red-legacy-snapshot-settings` → 备份回归：旧整库快照恢复也不能复活程序设置，来源旧行仍在。
- `t12-red-batch-rollback` → `t12-green-batch-rollback`：多库后一库原图损坏，不留下可用的前一库。
- `t12-red-target-identity` → `t12-green-target-preflight`：目标同一稳定 ID 的命名空间冲突，在内容发布前拒绝。
- `t12-red-ui` → `t12-green-ui`：正式入口名称与内容、设置边界。

`backup_content_definitions` 的 8 个父测试通过。两个 ignored 子进程入口由父测试实际调用。故障覆盖定义注入事务的 SQLITE_FULL 和退出码 99，以及首库发布后、首组发布后的 SQLITE_FULL 和退出码 99。检查实际中断、重开、整批回退、旧内容与设置保持、完整重试。ignored 入口没有重复计为顶层通过测试。

既有备份 plan、scope、crash、restore、Eagle 真实数据库和原图租约等 21 项回归通过。合入 T10 后完整 workspace 为 74 个顶层套件、669 passed、0 failed、11 ignored。统计只取每个顶层套件最后结果，不重复计算子进程输出。严格 workspace/all-targets Clippy、fmt、TypeScript 和 Vite 通过。[该次计算明细](evidence/spec78-t12/checks-t10.json) 固定源提交 `aa27349`。

## 原生发现的发布反馈缺陷

原生组合暴露了一个真实界面缺陷。纠正保存先发出 `VocabularyChanged`，随后资料库定义发布失败。界面显示失败后，排队的自动读取立即清除失败提示。用户无法看到需要重试的状态。

先补充公开渲染组件测试复现，再修复 `TagIdentityPanel`。自动读取保留未处理的发布失败。自动读取本身失败时，也保留该失败。用户明确重试或执行新操作时，沿用既有反馈更新行为。安全模式代次和迟到响应撤销保持。失败原件为 `t12-red-publication-feedback`、`t12-red-feedback-refresh-failure`；对应通过日志另存。

修复后前端 34 文件、267 项通过。TypeScript 和 Vite 通过。修复提交为 `304935205d1c3d8cece23a77543526e0d153aebb`。随后合入的 `8fc3f5` 只调整 `SaveDestination` 文档并重新生成绑定注释，不改变 Rust 运行逻辑。完整 Rust workspace 沿用上述实际检查，没有把它描述成修复后再次运行。

## 正式程序与源码绑定

最终冻结产品为 `00dfc611577361a679221dc8f06f99fdcedd466f`，tree 为 `1ffabb0724b1f6e308968dfb55092ae7c88361e2`。构建使用独立 identifier `dev.kinshoko.spec78t12test`、本树 target 和 jobs=2。命令为 `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --config work/e2e/t12-tauri-config.json`，嵌入实际 dist。

冻结 exe SHA256 为 `8de4d9202cae6919a53757aa31ee8e2e4bc48f0cc013669a2414ed9ec42ecb3c`。构建前、构建后和原生结束后的 538 项源码输入、10 项 dist 文件逐项一致。最终通过脚本提交 `846edf227d5b2c43692289dea06a11a97d38a17f` 只修正观察方法。产品输入相对冻结源码无差异。[最终绑定记录](evidence/spec78-t12/final-validation.json) 给出完整 SHA 和原始清单。

本机为 Windows 11 专业版 10.0.26300、64 位。实际 WebView 为 154.0.4258.62。通过轮主窗口视口为 1281×801，DPR 为 1.1041666269302368。端口为 4648/4649。各阶段使用独立数据目录和 WebView profile。

### 通过范围

第四轮内容备份组合通过 57 项断言。它在正式控件中设置名称偏好、纠正或拆分身份、增删别名，触发真实定义发布失败，再从正式入口备份和恢复。源库断开后，空白应用恢复 2 个独立库和 1 个跨库参考组。实际公开回读核对当前定义、来源、三个原图 SHA、目录和备注；恢复组打开为三个实际原生钉图。已有环境再恢复，核对当前偏好、别名删除、全局组和个人规则保持。

同一轮在首库发布后和首组发布后分别实际结束故障进程。前者留下 1 个新库、0 个新组，后者留下 2 个新库、1 个新组。两次各有 1 份持久回退记录。重开后本批次撤回，旧库、旧组、当前设置和原图保持；正式界面完整重试均通过。组阶段的日志字节原件另存。库阶段保留的是结果中的实际解析观察，没有把它称为日志字节原件。

恢复完成依据实际渲染文字、`registered_libraries`、`reference_groups` 和只读 SQLite 来源回读。没有替换 invoke，也没有合成 IPC 返回。文件选择使用既有测试路径队列。数据库、原图、备份/恢复动作和原生进程均实际运行。

同一冻结 exe 随后执行 smoke。建库、明确导入目标、导入 3 张图、瀑布流比例、精确进程重启后的库身份和图片墙保持，共 5 项断言通过。smoke 保存实际执行的 CRLF 脚本字节，并核对与该提交 Git LF 内容只有换行差异。

### 三轮失败原件

第一轮在控件仍 loading 时立即检查反馈，失败状态保留。第二轮增加等待后仍失败。第二轮 predicate 还误用了显式发布的文案，不能只凭该失败归因；其后公开渲染 RED 实际证明自动刷新清除失败提示，产品修复与文案修正分别完成。

第三轮使用已修复产品。实际备份和空白恢复完成，但脚本依赖替换 invoke 观察返回值，没有取得所需观察，整轮仍记 failed。第四轮对同一 exe 实际读取该属性为 `writable:false`、`configurable:false`，改用实际完成界面和公开事实回读。第三轮没有改成通过，前三轮结果、DOM、截图和各自实际脚本均保留。

### 截图与设置的证明范围

开发者已静态查看第四轮全部 7 张截图。[逐张范围](evidence/spec78-t12/native/screenshots.md) 记录可见内容。02 只露出备份段落顶部，不能单独证明预览数值。03 的成功文字在视口下，不能单独证明恢复成功。05/06 展示当时的范围，不单独证明设置保持或回退完成。对应结论来自实际 DOM 和公开回读断言。窗口已关闭；最终可见组合截图由 T20 后续补验。

`%APPDATA%/dev.kinshoko.spec78t12test/settings.json` 实际不存在。首次启动前、第三轮前、通过轮全部七个阶段及 smoke 前后均记录 `exists:false`、`sha:null`。各阶段实际 `shell_settings` 已保存。独立数据目录不会清空该 KnownFolder。没有执行清空操作。此前进度消息曾误称文件存在，以原始观察为准。

结束后，自有两个冻结 exe、对应 driver 和 T12 WebView 均未残留。4648/4649 无连接。释放记录 UTC 为 `2026-10-08T19:26:26Z`。只结束精确测试程序并清理自有 driver，验证进程重启恢复；未将故障退出或强制退出当作正常托盘 Quit 验收。

## 未验证与独立后续

Windows 10 未验证。用户明确没有相应设备或虚拟机，并接受保留该状态。

T13 程序设置备份、T20 全流程组合、规模性能和发行门槛由各自工单验收。本单不继承其通过状态。根任务负责独立合并审查、GitHub 交付和关闭工单。

独立合入完成于 `2db1c68bacaa781186a20f9c1f0f29f483770bc7`，tree与worker相同。fmt、TypeScript、脚本、whitespace和4个公开前端套件73项成功。[独立结果](evidence/spec78-t12/independent-merge-result.json) 另列证据审计。111条副本中107份是原始字节，4份历史harness从Git LF blob重建；smoke物理原件另为CRLF。逐阶段KnownFolder观察与root源码换行差异按证据索引限定，未把缺失观察补成事实。
