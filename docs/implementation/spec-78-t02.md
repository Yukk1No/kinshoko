# #78 T02：统一标签身份（#80）

本记录仅覆盖 #78 故事 17、18。本单从 `47e964ee16868c681e4db38252e3d5e3dd998d1e` 的独立工作树开始。#42、#71、前置规格及历史验收保持原范围。

- 独立领域决定：`657941b`，新增 [ADR-0006](../adr/0006-application-tag-catalog.md) 和术语；未改写 ADR-0003 原文。
- 可执行实现与 E2E 脚本：`10d77a1363d533a7fa32569be152df06ef388dff`，Git tree `91b3749cdcff11b3f3d8e23bc62bc4650f8a0f1a`。领域文档提交不作为可执行源码版本。
- 最新集成合并：`d656f7fbbca371fc75e971e167025f74157c4c00` 合并 `3caef213e0ce011b925df24d9defe3ebbced05d2`。未改动本单产品源码；T16 的显示／截图增量另有验证。

## 公开契约

核心入口为 [`TagCatalog`](../../crates/kinshoko-core/src/tag_catalog.rs)，不依赖 Tauri。

- `open(dir)` 打开应用持久目录 `tag-catalog.sqlite`。统一 ID 独立于库内 ID、名称和外部词表值。
- `synchronize(library)` 建立 `(library_id, local_tag_id) → catalog_id` 显式对应。只有同命名空间中的明确外部对应自动共享身份；名称和别名重合不合并。旧格式的外部值明确解释为 `danbooru` 词表。
- 后加的明确外部对应也会接入已有身份。多个外部值分别指向不同身份时，保持独立并返回 `conflictingExternal`，等待明确选择。
- `correct(library, local_tag_id, Use { catalog_id } | Separate)` 纠正或拆分对应。不同命名空间会拒绝对应。显式选择在重开和后续同步后保持；不写入逐图人工决定。
- `local_tag_ids(library_id, catalog_id)` 解析内容提供方的实际 ID，结果允许一个统一身份对应同库多个本地标签。
- `search_vocabulary` / `CatalogInspection::search_vocabulary` 提供兼容本地 ID 的查找视图。纠正后的共享定义用于查找，旧主要显示文字继续保留。
- `image_tags` 返回原有图片标签及其统一身份。正式标签面板展示对应身份；人工编辑继续传库内 ID。
- `inspect_libraries` 检查已登记库，保留不可用状态，不切换活动库。`DeviceLibraries::read` / `Library::open_read_only` 每次返回隔离只读句柄，包括当前库；检查可以设置自己的安全视角，不改变活动库的视角。

`CatalogTag` 的名称和别名仅是初始定义。`LibraryTagMapping.legacy` 保存首次接入定义，`nameProvenance=pending` 等待 T03／T04 的默认、偏好与名称迁移流程。应用接入改用 `Library::use_translations_for_new_tags`，不会补写旧标签名称；原有 `set_translations` 兼容入口保留。

## 正式接入与原型来源

Tauri 的 `inspect_tag_catalog`、`correct_tag_mapping` 和 `catalog_image_tags` 转发核心动作。候选查找和条件解析采用统一定义投影。目录修订或纠正会使 SearchCache 失效；纠正发出现有词表事件，刷新正式查找和标签面板。两个检查响应边界重查安全模式及切换代次；旧视角请求不能返回迟到记录。前端接收全局安全模式事件后清空检查表，并丢弃先前代次的成功和错误结果。

设置中的“统一标签目录”检查表提供本地／统一 ID、命名空间、外部对应、原名称、别名和名称来源待处理说明。使用者选择同命名空间目标或“拆成独立标签”，再保存。主界面和查看器继续使用各库人工添加／否决操作。

直接参考固定原型 `bd8aea44c4a311571ee3c07382cb7755f87f3153:prototype/reference-browser` 的 `SettingsDialog.tsx`（`settings`／`fieldset`／`legend` 与明确动作行）和 `InfoPanel.tsx`（标签与来源文字）。正式接入复用这些结构及现有 TagPanel。T02 未修改 T01 的应用壳、图片墙、查看器和 CSS 基线。

## 红绿证据

全部新核心场景通过公开动作、真实临时 SQLite 库和 PNG 文件验证，没有私表查询断言。前端行为测试仅补充 IPC 与事件边界。

初期使用共享 `target` 的通过结果已作废。发现跨工作树构建结果可能冲突后，全部有效通过结果使用 T02 自己的 `target` 重新验证，Cargo 并发为 2。最初失败仅作为 TDD 轨迹，独立通过证据另计。

| 场景 | 先观察的失败 | 独立通过 |
| --- | --- | --- |
| 两库不同本地 ID 共享外部对应并重开 | `tag_catalog` 模块不存在 | 公开行为测试 |
| 无外部对应、别名歧义、纠正及人工决定独立 | `correct` / 查找投影 / 图片身份动作不存在 | 公开行为测试 |
| 同一身份增加明确外部对应 | 返回 2 个身份，预期 1 个 | 公开行为测试 |
| 不切库检查已登记提供方 | `read` / `inspect_libraries` 不存在 | 公开行为测试 |
| 旧库未翻译显示保留 | `use_translations_for_new_tags` 不存在 | 公开行为测试 |
| 首次登记后补外部对应 | 返回 2 个身份，预期 1 个 | 公开行为测试 |
| 后补外部值指向已有身份，显式拆分仍优先 | 仍返回旧独立身份 | 公开行为测试 |
| 外部对应歧义可检查并纠正 | `ConflictingExternal` 状态不存在 | 公开行为测试 |
| 正式设置检查并保存对应 | `TagIdentityPanel` 不存在 | 补充前端行为测试 |
| 活动库安全模式为开，执行旧的关闭视角检查 | 活动库被检查动作切为关闭 | 公开行为测试；封印图仍不可用 |
| 安全模式切换后的迟到检查／纠正结果 | 检查表重新显示旧视角记录 | 两项补充前端行为测试 |

同名无外部对应保持独立、不同命名空间拒绝对应、拆分和重开均有公开行为覆盖。安全模式失败／通过日志为 `work/e2e/safe-inspection-red.log`、`tag-catalog-green.log`、`safe-panel-red.log`、`safe-panel-green.log`。

## 环境、命令与结果

验证日期为 2026-10-08（Asia/Shanghai）。开发机环境为 Windows `10.0.26300.0`，Rust `1.95.0 (59807616e 2026-04-14)`，Node `v22.15.0`，WebView2／EdgeDriver `154.0.4258.62`，tauri-driver `2.1.0`。前端依赖通过只读 `node_modules` junction 复用，未修改共享依赖。

全部命令在 T02 工作树执行；日志保存在本工作树 `work/e2e/`。

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
$env:CARGO_BUILD_JOBS = '2'
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -j2 -- -D warnings
cargo test --workspace --locked -j2
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --config work/vitest.config.ts
node node_modules/vite/bin/vite.js build --config work/vitest.config.ts
$env:TAURI_CONFIG = '{"identifier":"dev.kinshoko.spec78t02test"}'
cargo build -p kinshoko --features tauri/custom-protocol --locked -j2
node e2e/tag-identity.mjs target/debug/kinshoko.exe C:/Users/yuk1no/.codex/worktrees/spec78-t01-frontend/kinshoko/work/e2e/tools/msedgedriver.exe
```

工作区保留的 5 项 ignored 为 4 个由父测试启动的故障注入子入口，以及大库性能测量；本单没有新增 ignored。

`work/vitest.config.ts` 仅把 Vite/Vitest cache 放进本工作树 `work/vitest-cache`，没有修改产品配置。

| 检查 | 结果 |
| --- | --- |
| 新目录核心公开场景 | 11 通过 |
| 核心 lib 与类型生成 | 149 通过 |
| 相关公开兼容回归 | device 7、safe_mode 18、search 9、search_cache 7、tags 14、translations 4 通过 |
| Tauri lib | 5 通过 |
| Rust 工作区完整回归（实现提交） | 526 通过、5 项既有 ignored；0 失败 |
| 合并集成后的针对性回归 | 目录 11、设备 7、安全模式 18 通过；Tauri all-targets check 通过 |
| 正式前端完整回归 | 24 个文件、214 个测试通过 |
| TypeScript、Vite 生产构建 | 通过 |
| Tauri all-targets check、工作区 clippy、格式 | 通过 |
| 独立 identifier 的嵌入式原生构建 | 通过 |
| 正式应用 WebDriver | 10 项断言通过；下面单独记录 |

## 原生正式应用证据

通过记录：`work/e2e/tag-identity-1791470925183/result.json`；日志为 `work/e2e/tag-identity-native.log`。完整绝对路径为 `C:/Users/yuk1no/.codex/worktrees/spec78-t02-tag-identity/kinshoko/work/e2e/tag-identity-1791470925183/`，包含两份真实资料库、隔离应用目录、纠正／重开／安全模式截图。目录保留供复查。

原生运行使用上述实现提交中的产品源码，二进制在提交前由相同工作树构建，之后产品源码未改动。不是对后来集成分支代码的原生验证。构建后的源码与提交逐项核对；清单为 `work/e2e/native-production-tree.txt`，391 个文件逐项匹配，清单 SHA256 为 `CCD8A204642FD0F75A3013ACF9817B980F6B05593BBA7EEEE457CCE67EE047B9`。运行二进制 `target/debug/kinshoko.exe` 的 SHA256 为 `67B5AB6FC4ED50289B46B4F13CE550B2D2EC0981227B6F486AEF64036065E7B0`。

应用 identifier 为 `dev.kinshoko.spec78t02test`；数据目录为该记录目录下 `app-data`；WebDriver 使用 4446／4447 端口，设置 `KINSHOKO_SKIP_AUTOSTART=1`。脚本最后只结束自身应用路径及自身 driver 子进程，退出后确认本次应用与 driver 已结束。

步骤：用公开 Tauri 动作新建两库、导入 PNG、建立不同本地标签及重合别名；完整退出并重开，在正式设置检查表选择目标并点击保存；验证查找和图片身份；修改第一库人工否决后核对第二库；再次完整重开；关闭安全模式、把第二库图片设为封印分级、检查对应，再开启安全模式。

通过的 10 项断言：

1. 重合别名不自动合并身份。
2. 两库确实使用不同本地 ID。
3. 正式控件保存纠正后的统一身份。
4. 图片标签身份采用纠正后的统一定义。
5. 旧显示文字和原人工决定不变。
6. 纠正后的共享定义可查到第二库本地 ID。
7. 第一库人工否决不改变第二库人工决定。
8. 对应在完整应用重启后保持，检查表显示已纠正。
9. 检查动作不解除活动库图片的封印。
10. 安全检查不返回只属于封印图的标签定义；全局模式事件已使旧检查表清空。

最初原生尝试未计作通过：一个 XPath 错误只检查 React 的第一个文本节点，另有启动／重开时尚未出现 IPC 或设置控件的等待缺失。脚本已修正，最终完整运行在安全模式修正后通过。

## 后续 T03／T07 的接入提示

- T03：以统一 ID 改定义，以 `(library_id, local_tag_id)` 保留兼容。`legacy` 是首次快照，不是全局偏好。`pending` 需要显式迁移选择；当前共享名称只是初始定义，不承担默认更新／偏好语义。后续定义写入应推进目录 revision，并使查找和标签面板刷新。
- T07：用 `local_tag_ids` 将统一条件解析回各库 ID，再让资料库提供内容。原始 `inspect` 保留历史映射，不能直接当成可浏览内容清单；需要检查提供方可用性和当前可见性。`inspect_libraries` 已展示这层过滤。
- 所有提供方读取使用隔离只读句柄，包括活动库。按请求设置读视角，禁止用检查请求改变活动库的安全模式。响应边界及前端都需要模式代次保护。
- 目录 revision 独立于库内词表 revision。Tauri 在建立 SearchCache 投影期间保持目录串行，避免旧投影在纠正后重新写入缓存；纠正还显式失效缓存并发出当前库词表事件。后续不能只比较库内 revision。

## 未验证

开发者真机验收未执行。开发者需在实际安装环境检查两份旧资料库的名称保留、对应纠正、查找、逐图人工决定独立及退出后重开。自动 WebDriver 操作不替代该验收。Windows 10／11 发布组合和安装包检查归组合验收，本单未宣称通过。
