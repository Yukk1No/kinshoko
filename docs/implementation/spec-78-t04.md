# #78 T04：旧库名称迁移（#83）

本单覆盖故事 25、26。尚无明确共享选择的旧库继续显示旧文字；已有全局偏好继续优先。正式设置向导按统一标签身份和语言列出每份旧文字、对应资料库、当前实际显示、默认名称和已有全局偏好。确认前展示全局结果；取消只丢弃草稿。选择跟随默认会删除该语言覆盖，选择保留旧名称会写入显式全局偏好，即使文字与当前默认相同。

本单从集成 `7599a9fbf6ddfb40c37d9596ce86ed301617cb9c` 创建 `codex/spec-78-t04`，复用已结束 T03 的 clean managed worktree。核心和正式 UI 为 `029dff4`；合入 T07 集成 `71e635dabe38ff4e7ef55695088addd8bfa9881b` 的 merge 为 `4cc3b7a`。冲突仅在 App、IPC import 和样式，双方功能同时保留。随后无冲突合入 T19 集成 `921c712e5ac423ac32af5ef396243a63acfb21b3`，本树 merge 为 `585048a`。#42／#71、旧实施记录和原 dirty 翻译输入未改写。本单没有 push 或操作 GitHub。

## 名称归属与原子性

[`TagCatalog` 的公开迁移动作](../../crates/kinshoko-core/src/tag_catalog/migration.rs) 承担规则，Tauri 只适配资料库和安全视角。

- `plan_name_migration(visible)` 按首次接入时记录的旧本地身份及旧文字生成计划。名称来源状态与迁移确认记录分别保存。T03 已设置过全局偏好，也不能让后来接入的旧来源从向导消失。
- `preview_name_migration(plan, decisions)` 检查目录修订、完整选择和来源对应。先计算整批各语言的最终偏好，再使用核心显示规则计算回退。预览不写入偏好或确认记录。
- `confirm_name_migration(plan, decisions)` 重新验证计划，在一次 `IMMEDIATE` SQLite 事务内保存整批偏好、独立旧来源确认、统一身份的共享名称采用状态、可删除旧别名与一次目录修订。不是逐项提交。后续失败或进程中断会回滚全部项目。
- 确认按 `(library_id, local_tag_id, catalog_id)` 记录，后接入的旧来源继续单独确认。已有全局偏好保持最高显示优先级；旧文字不会因接入顺序覆盖它。向导同时列出旧文字与实际当前显示，并明确说明改成默认会撤回该语言的全局偏好。
- 确认作用于共享身份，影响已经对应和以后对应的库。其他语言的显式偏好独立。旧名称和被撤回的偏好成为可删除的其他叫法；既有删除记录不会被迁移重新加入。
- 图片、库内标签 ID、对应关系和逐图人工决定不由该事务改写。

应用级统一标签目录从 schema 2 升为 3，新增独立确认表与 `library_tag_mapping(catalog_id)` 索引。T04 不新增资料库内容 schema 迁移。旧库打开仍经过已有正式升级路径。计划构造一次建立身份、受影响资料库和待确认来源索引；预览复用身份索引，避免为每个来源线性查找目录和为每项扫描全体对应。

## 正式界面与原型

直接读取并适配已接受的 [`tag-name-model.html`](../../prototype/spec78-alignment/tag-name-model.html) 旧来源表、明确选择与结果表达，以及固定认可 SettingsDialog 的 fieldset／legend／明确动作结构。正式 [`LegacyNameMigrationPanel`](../../src/library/LegacyNameMigrationPanel.tsx) 接入设置；打开含待确认名称的活动库时，主界面通知可直接打开向导。

向导每次显示一个身份和语言，提供跟随默认、保留指定旧文字、保留既有全局偏好。不同旧文字和旧文字与已有偏好的冲突均明确显示。来源表保留库名、本地身份和原文字。影响说明覆盖全部关联库及以后接入的库。

大库可以明确点击“未选无冲突项跟随默认”。该动作只选择无既有偏好、无不同旧文字、尚未选择的项；冲突和已有偏好仍待用户决定，已选项保持原样。最终预览每页最多 20 行。确认按钮绑定当前完整选择序列与目录修订；用户改变选择后，必须等核心返回对应的新预览才能确认。失败保留草稿以重试；模式变化清空视图并丢弃迟到响应。

三个正式 IPC `plan_legacy_names`、`preview_legacy_names`、`confirm_legacy_names` 在前端、Rust handler、inline plugin `build.rs` 列表中一致登记；沿用 `capabilities/default.json` 的 `library:default`。适配器复用核心安全可见投影并在响应边界复核安全模式代次。

## 独立 RED → GREEN

本单应用 TDD 技能，验证边界在开始前已经确认。核心测试用公开动作、真实 SQLite 与真文件；不以私表断言证明业务规则。冻结的 [`spec78-legacy-v16.sql`](../../crates/kinshoko-core/tests/fixtures/spec78-legacy-v16.sql) 来自发布基线 `536cc43c1933e44fc33836f8a439de8cdb0da018` 的前 16 个正式 migration。测试创建旧 `library.sqlite`、真实 PNG、旧模型事实及人工 add，再通过 `Library::open` 正式升级。

| 场景 | 实现前的失败 | 通过证据 |
| --- | --- | --- |
| 旧显示保留、取消、确认后共享与重复打开 | 公开 migration 类型和动作缺失 | `t04-choice-green.txt`、`t04-final-core.txt` |
| 后接入旧来源与既有全局偏好冲突 | 公开 migration 动作缺失 | `t04-preference-conflict.txt`、`t04-final-core.txt` |
| 中途失败／进程中断全批回滚与重试 | 第二项未触发中断，子进程退出 0，预期 99 | `t04-atomic-green.txt`、`t04-final-core.txt` |
| 被撤回的偏好保留为可删除别名 | 别名缺失 | `t04-displaced-name-green.txt` |
| 真旧 v16 文件往返、本地 ID 与人工决定保留 | 沿用前述缺失动作的 RED | `t04-old-v16-green.txt`、`t04-final-core.txt` |
| 跨语言回退整批预览 | 公开 preview 动作缺失 | `t04-fallback-preview-green.txt` |
| 正式向导、取消、失败重试与模式代次 | 组件缺失 | `t04-ui-green.txt` |
| 打开旧库的迁移通知 | 通知组件缺失 | `t04-open-notice-green.txt` |
| 252 项批量选择、冲突保留和 20 行预览 | 批量按钮缺失 | `t04-bulk-ui-green.txt` |
| 当前选择对应的预览才允许确认 | 当前预览绑定的公开行为断言 | `t04-final-preview-ui.txt` |

故障测试使用既有 `KINSHOKO_FAULT` 计数机制。在第二项事务写入后分别触发 `SQLITE_FULL` 错误和真实子进程退出 99。重新打开后整批仍待确认、原显示不变；无故障重试成功，旧计划再次确认被拒绝。ignored 的 child 仅是子进程入口，父测试实际启动了错误与退出两条路径。

1201 项真实旧库批次用公开接口完成规划、全批预览和单事务确认，保留既有显式偏好冲突与人工决定。没有把任意 100ms 阈值作为验收标准。

## 命令与回归

2026-10-09（Asia/Shanghai），Windows `10.0.26300.0`、Rust `1.95.0 (59807616e 2026-04-14)`、Node `v22.15.0`、WebView2／EdgeDriver `154.0.4258.62`、tauri-driver `2.1.0`。Cargo 只使用本工作树 `target`，并发 2；依赖 junction 只读，Vite/Vitest cache 在本树。

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
$env:CARGO_BUILD_JOBS = '2'
cargo test --workspace --locked -j2
cargo test -p kinshoko-core --test legacy_name_migration --test tag_catalog --test tag_names --locked -j2
cargo test -p kinshoko-core --test legacy_name_migration --test workspace --test tag_names --locked -j2
cargo clippy --workspace --all-targets --locked -j2 -- -D warnings
cargo fmt --all --check
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --config work/vitest.config.ts
node node_modules/vite/bin/vite.js build --config work/vitest.config.ts
$env:TAURI_CONFIG = '{"identifier":"dev.kinshoko.spec78t04test"}'
cargo build -p kinshoko --features tauri/custom-protocol --locked -j2
node e2e/legacy-tag-names.mjs target/debug/kinshoko.exe <matching-msedgedriver.exe> C:/Users/yuk1no/.cargo/bin/tauri-driver.exe
```

| 检查范围 | 状态与实际覆盖版本 |
| --- | --- |
| Rust 完整工作区 | 开发阶段完整命令通过；后续预览、索引和批量边界独立补验，不把旧完整运行算作最终版本全跑 |
| 最终迁移／目录／名称核心 | 7／11／8 通过；迁移 child 入口另被父测试实际执行 |
| T07 合入后的迁移／名称／工作区 | 7／8／7 通过，见 `t04-merged-core.txt` |
| 合入前全前端 | 27 文件、231 测试通过，包括 6 项新迁移行为 |
| T07 合入后的受影响前端 | 4 文件、69 测试通过：App、启动分支、workspace wall、迁移向导 |
| TypeScript／Vite | 合入后通过 |
| all-targets Clippy／fmt | 合入后通过，包含 Tauri |
| T19 合入后新增范围 | update_policy 3 项、设置／更新／迁移前端 3 文件 25 项、TypeScript、Vite、Clippy 和格式通过；只补验新变化 |
| 独立原生构建 | 通过；准确产品来源与原生结果见下 |

## 原生正式程序证据

故事 25／26 的原生迁移段有 **34 项通过**。原始组合运行目录为 `work/e2e/legacy-names-1791477190716/`。[迁移段结果](evidence/spec78-t04/native-migration-segment.json) 只列已经观察通过的 34 项；[原始完整报告](evidence/spec78-t04/native-combined-run-tray-red.json) 仍明确为 failed，因为后续追加检查误把关闭主窗口当成进程退出。没有改写该失败，或把整次组合运行说成全绿。

该段实际运行产品在 `b45941dfe605c1509f47871a87e33bc852641d9b` 构建；通过迁移段的脚本来源为 `e350dfd1a884c27d37950ccfb9032d2c55c1174c`，中间仅脚本变化，产品源文件和嵌入 dist 相同。[源码、dist、binary、driver 清单](evidence/spec78-t04/native-migration-source.json) 固定来源。二进制 SHA256 为 `1ED64C1061F148B5A42FFF93E565C63833F236DD743CB9B30519A8991BEE327B`，原件保存在本树 `work/e2e/nativeproof/t04-b45941d/kinshoko.exe`。driver SHA256 为 `0F4600639201CCD2E84C72C3977AC33C67E19152E197C89EB16A6591D1FBE9F7`。

步骤包括：打开四份冻结 schema v16 的真实资料库；正式标签面板检查不同旧显示；向导显示两种旧文字，选择默认后取消并重启；保留第二库旧名为全局偏好，核对两库与重启；第三旧库接入时既有偏好继续最高优先，但仍显示旧文字冲突；明确跟随默认撤回偏好；第四库旧文字等于默认时仍保存显式偏好；确认旧别名、本地 ID、人工决定及四份原文件哈希不变。三个新增正式 IPC 在实际 WebView 权限下均执行成功。

只追加重跑了剩余 T07 启动段，**9 项通过**，没有重复已通过的迁移段。最终组合脚本没有再次一口气全跑；证据分别归属于 34 项迁移段与 9 项独立补验。使用相同 T04 binary 和已升级的四库，脚本来源为 `5d4d85ec59b2084a8db6fb67700c9454e597afef`：[结果](evidence/spec78-t04/native-startup-result.json)、[脚本与 binary 来源](evidence/spec78-t04/native-startup-source.json)。通过公开动作保存 safe=false，经真实托盘“退出”正常结束进程，再断开最后活动库路径。重启后无活动库，另外三库仍聚合为一张图，断连来源明确不可用，默认查找范围为全部资料库，保存的非安全视角不变。

[`native-tray-exit-t04.py`](../../e2e/native-tray-exit-t04.py) 从 T19 已验证 helper 适配，限制本树 `target/debug/kinshoko.exe` 的精确绝对路径及唯一 PID。每次重新打开实际托盘菜单，核对 fresh popup、owner、末项“退出”的文字、状态与 ID，先 WM_CANCELMODE 收起菜单再 WM_COMMAND 进入正常回调。[退出前 receipt](evidence/spec78-t04/before-disconnect-tray-exit.json) 与 [退出后 receipt](evidence/spec78-t04/after-disconnect-tray-exit.json) 均为退出码 0、processEnded=true；该通过路径没有全局按键、私有命令、WM_QUIT 或强杀应用。WebView 清理日志中的 class unregister 1412 没有改变已记录的正常进程退出结果。

identifier 为 `dev.kinshoko.spec78t04test`，driver 4458／4459。资料库、设备目录与 WebView profile 在本次 `work/e2e` 目录。Windows 已知目录 API 实际把应用壳设置放在独立 identifier 的 `C:/Users/yuk1no/AppData/Roaming/dev.kinshoko.spec78t04test/settings.json`，APPDATA 环境覆盖没有重定向该设置；因此不声称全部配置均在运行目录。后续完整脚本已显式初始化安全视角，避免复用测试 identifier 的 safe=false 影响下一轮。生产 identifier 的设置不在本单操作范围。[退出清点](evidence/spec78-t04/desktop-release.json) 确认应用、两种 driver、本测试 WebView 无残留，两端口无监听；桌面已释放。

原始失败均保留：库选项未装载的脚本等待、标签检查期间选中被清空、WebDriver 控件 stale、误判托盘常驻及复用 safe=false 的脚本初始化。诊断 DOM 显示标签曾正确出现，随后选中被清空。该现象并不全是脚本：首次重复同一修订的 workspace 通知会造成真实交互中断，T09 已独立 RED 复现并承接同修订去重／迟到状态修复；真实修订变化后的撤销另有合法语义。此处保留自己的失败证据，不把之后 T09 修复算成本单已执行的原生验证。

已逐张检查 [冲突与取消](evidence/spec78-t04/formal-legacy-conflict-cancel.png)、[保留旧名的选择](evidence/spec78-t04/formal-legacy-preference-preview.png)、[既有偏好冲突](evidence/spec78-t04/formal-existing-preference-conflict.png)、[确认保存](evidence/spec78-t04/formal-equal-default-explicit-choice.png)、[活动库断连后的正式工作区](evidence/spec78-t04/formal-disconnected-active-startup.png)。最终结果核对和确认按钮等待在脚本中执行，保留旧名的截图拍在预览请求尚未完成时，没有用这张截图代替最终结果断言。

原生 binary 早于后续 T19 合入；T19 更新策略／设置变化只有上述新增专项、TypeScript、Vite 与 Clippy 补验，不冒充新集成 binary 的原生验证。最终 [`validation.json`](evidence/spec78-t04/validation.json) 和 [证据哈希](evidence/spec78-t04/evidence-hashes.json) 记录实际覆盖边界。

## 未验证

开发者实际安装环境的真机验收未执行，状态为未验证。自动 WebDriver 使用真实 Windows 应用、旧 SQLite 与 PNG，不能替代开发者用实际旧库检查名称、选择结果和重开的真机验收。Windows 10、发布安装包矩阵、多显示器／DPI 组合和真实海量旧库的人工体验未在本单宣称通过。中断和写入失败的原子性由真实 SQLite 的核心进程测试验证；没有在原生界面注入磁盘故障。
