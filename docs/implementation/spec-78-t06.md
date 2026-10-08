# #78 T06：全局个人近似规则

本单对应 #85、故事 30／31／32。个人相近与不相近规则现在由应用统一保存。不同资料库通过统一标签身份共用判断；没有外部对应的标签也能参加。

这是独立增量。前置基线为 `536cc43c1933e44fc33836f8a439de8cdb0da018`，没有改写 #42／PR #71 或旧验收状态。分支 `codex/spec-78-t06` 从精确集成 `04f12936e8f9b831e6b6619c1d6b0f44a64d7749` 开始，复用已结束 T05 的 managed tree `spec78-t02-tag-identity/kinshoko`，旧分支及 ignored 证据保留。本单产品提交为 `c01ba462cf1af0954b84fdee2d0d1d2d02c3cb18`；合入 T11 的 `f5f060645d285cc484c76688e5f39a9ec02da524` 后，正式程序来源为 `49c39e0c4a7df150183e48d27883e0c5fca82c9f`。随后只修改 native harness，并合入 `e9be4ea11fdd610270936e13e257e600d199d01f` 的文档与一行测试清理。

## 规则归属与查找行为

[`tag_catalog/approx.rs`](../../crates/kinshoko-core/src/tag_catalog/approx.rs) 保存规范化的统一标签对。应用目录 schema 升至 5，新增 `catalog_approx` 和 `catalog_approx_migration`。内容库 schema 没有新增个人规则表。已有 Library 级 API 保留在兼容与旧规则迁移边界，工作区正式查找使用全局定义。

显式个人判断优先于内置表。同一对的“不相近”阻止内置“相近”，内置版本更新不会覆盖个人判断。“只这次”只修改当前 `SearchInput` 的 dismissed 集合；清空后重新查找会恢复展开。“以后都不展开”原子保存统一标签对的长期不相近判断。“＋”保存长期相近判断，不要求外部对应，也不要求提供方是当前活动库。

展开仍是一条条件中的可见任一标签。多个条件继续求交，排除仍排除该条件，精确查找关闭展开。近似关系没有合并统一标签、没有合并库内标签，也没有修改图片的人工标签与原文件。

## 旧判断、未决冲突与删除记忆

旧 provider 的 `personal_approx` 只作迁移来源读取。每个 `(library_id, local_a, local_b)` 只迁移一次。来源保存原始库名、位置、旧库标签对及原判断；当前规则使用统一身份。后续修改映射或个人判断不会重写来源历史。

相同旧判断可以自动沿用。相反旧判断保留双方来源，必须明确选择“相近”“不相近”或“不采用旧规则”。没有显式全局判断的未决冲突暂时停止展开，这不是保存了“不相近”。界面与公开 `CatalogApproxView` 区分这两个状态。没有已有显式判断时，选择“不采用旧规则”会恢复内置行为。已有显式全局判断时，新来的相反旧来源不覆盖它；“不采用旧规则”确认新来源并保留当前判断。公开编辑携带 revision，过期冲突选择不能写入。

显式设置、冲突确认和删除会保存来源确认状态。删除使用空判断的显式记忆；旧库仍存在时，重启不会使旧规则复活。批量编辑先验证全部身份与当前授权词表，非法隐藏 ID／未知 ID 不留下部分写入。

[`ADR-0007`](../adr/0007-application-personal-approx.md) 单独记录新的应用归属与迁移选择，替代 ADR-0003 最后一项关于个人规则按库保存的历史结论。旧 ADR 原文保持不变。根 `GLOSSARY.md` 同步现行定义。

## 全量设置与安全投影

后续 T13 的公开核心边界为 `TagCatalog::approx_definitions()`、`approx_decisions()`、`approx_migrations()`。活动规则、显式／自动判断、空判断删除记忆、完整旧来源、来源确认状态分别可读。T13 必须完整保存及替换这些数据与必要的统一身份。普通 UI 只接收可见的 `CatalogApproxView`，不暴露全量原始定义。恢复动作由 T13 实现，本单没有把读取接口说成完整备份。

这些数据属于程序设置。资料库内容备份不能带入或替换它们。T12 会在内容快照副本／内容恢复生命周期排除旧设置，避免新 library ID 重新触发 legacy 迁移；原 provider 不因此改写。

设置与编辑使用 T05 的全来源管理词表。同字节图片只要任一已知来源为 Adult，安全模式就隐藏其专用标签与对应规则，包含范围外、未命中和已知离线来源。安全模式只过滤投影，不删除完整定义。合法零使用定义仍可管理。Workspace 使用独立只读 provider 取得事实，不改变活动库的安全模式。

## 正式界面与原型参考

直接读取固定认可原型 `bd8aea44c4a311571ee3c07382cb7755f87f3153` 的 [`SearchBox.tsx`](../../prototype/reference-browser/src/components/SearchBox.tsx) 与 [`search.ts`](../../prototype/reference-browser/src/search.ts)。正式 `SearchBox` 继续沿用其条件 chip、输入文字与选择标签的区分、任一／排除及可见展开结构，适配既有正式界面的长期动作。原型没有本单所需的全局持久规则管理，因此这部分由核心与正式设置新增，未声称复制原型已有功能。原型两文件的 Git blob 保持不变。

[`SharedPersonalApproxSettings.tsx`](../../src/search/SharedPersonalApproxSettings.tsx) 在无活动库时也显示当前规则、删除与来源。相反来源显示库名和最短可区分路径，完整位置在提示中；三种选择与当前已有全局判断的说明分别显示。来源标记设置继续默认关闭。

设置先读取实际保存的安全模式与工作区修订，再加载视图。模式或工作区代次变化会清空旧视图并拒绝迟到响应；同一修订的监测通知不清空正在显示的数据。SearchBox 的“＋”和取消展开对话框绑定当前视角，视角变化关闭旧对话框，迟到响应不得重新显示旧标签。

两个正式 IPC `shared_personal_approx`、`edit_shared_approx` 在前端、Tauri handler 与 `src-tauri/build.rs` inline commands 一致登记，沿用 `library:default`。原生 handler 只适配全局核心、安全模式代次和工作区刷新。

## 独立 RED → GREEN

应用 TDD 技能。新增 [`catalog_approx.rs`](../../crates/kinshoko-core/tests/catalog_approx.rs) 8 个公开核心检查，使用真实 SQLite、真实 PNG、公开 Search 与 Workspace 行为；没有用检查私表替代业务验收。新增 [`SharedApprox.test.tsx`](../../src/search/SharedApprox.test.tsx) 5 个正式组件行为检查。

| 场景 | 实现前失败 | 通过证据 |
| --- | --- | --- |
| A 的旧“不相近”作用于 B 的不同库内 ID，重启保持 | 真实行为失败：A's personal rejection must override the built-in pair for B too | `core-red1.log` → `core-green1.log` |
| 两种登记顺序的相反旧判断都停止自动展开 | 真实行为失败：an unresolved opposite legacy judgment must not silently expand by order or built-in fallback | `core-red2-behavior.log` → `core-green2.log` |
| 无外部对应的“＋”、一次性条件与图片判断不变 | 新公开 API 尚不存在，编译 RED | `core-red3-api.log` → `core-green3.log` |
| 明确来源冲突、忽略确认与内置恢复 | 新公开 API 尚不存在，编译 RED | `core-red4-api.log` → `core-green4.log` |
| 删除迁移规则、重启不复活、内置新版生效 | Remove 动作尚不存在，编译 RED | `core-red5-api.log` → `core-green5.log` |
| 后来相反来源的“不采用”保留既有全局判断 | 真实行为失败：返回 0 项，预期 1 项 | `core-red6-behavior.log` → `core-green6.log` |
| 内置更新、精确／任一／排除／AND、非法批量原子失败、全来源过滤与全量定义 | 在上述公开行为 RED 后增量覆盖 | `core-eight-pass2.log`、`core-merged1.log` |
| 无活动库的规则列表／删除 | 正式设置表不存在，真实组件 RED | `ui-red1.log` → `ui-green1.log` |
| 工作区“以后都不展开”与一次性条件 | 正式按钮禁用，不能调用全局动作，真实组件 RED | `ui-red2.log` → `ui-green2.log` |
| 冲突来源和选择、迟到不安全视图、无外部对应“＋” | 在前述 UI RED 后增量覆盖 | `ui-regression4.log`、`frontend-merged1.log` |

`core-red2.log` 与 `core-eight.log` 分别是检查代码的借用错误和不存在的 `Default` 用法，不算产品行为 RED；之后修正 fixture 才得到实际行为失败／通过。Clippy 首轮指出检查中的多余 clone，修正后严格检查通过。两轮 UI 回归先后捕获测试持有脱离 DOM 的旧表、旧对话框；检查改为查询当前正式控件，再完整复跑。原始失败均保留，未改写为成功。

## 实际检查与环境

2026-10-09（Asia/Shanghai），Windows 11 专业版 `10.0.26300`，Rust `1.95.0`，Node `v22.15.0`，WebView2／EdgeDriver `154.0.4258.62`，tauri-driver `2.1.0`。Cargo 仅使用本物理树的 `target`，并发 2。

| 检查 | 实际范围与结果 |
| --- | --- |
| T06 产品完成后的完整 Rust 工作区 | `workspace-tests1.log`：636 passed、0 failed、8 ignored，共 72 份结果页脚；早于 T11 合入 |
| T11 合入后的公开核心 | `core-merged1.log`：近似 8、分组 7、组合可见性 2、可携带定义 12、统一身份 11、工作区 7，共 47 项通过；另 1 个故障子进程入口由父检查执行 |
| 严格 Clippy | `clippy-merged1.log`：workspace／all-targets／-D warnings 通过 |
| 完整前端 | `frontend-merged1.log`：33 文件 260 项通过 |
| 最新整合的一行测试清理 | `frontend-integration-followup.log`：TagIdentityPanel 5 项通过 |
| TypeScript／Vite | `typecheck-merged1.log`、`vite-merged1.log` 通过；正式构建再次生成 dist |
| fmt／空白 | `fmt-final.log` 通过，产品与文档 `git diff --check` 通过 |
| 正式程序构建 | `native-build2.log`：独立 identifier debug 构建通过，1m08s |
| 原生正式操作 | `native-result.json`：30 项通过，包含正常退出和重启持久化 |

完整 Rust 的 ignored 包含由父检查执行的故障／性能子进程入口，也包含本轮未执行的旧大规模性能检查。不能把 8 个 ignored 全部说成已执行或全部说成未执行。第一次 `npm run tauri -- build ...` 的 PowerShell 参数转发失败，CLI 将配置路径误传给 Cargo；`native-build1.log` 保留该构建包装失败，未启动程序。改用明确 Node CLI 后构建通过。

实际命令如下；工作目录为本单物理树。

```powershell
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
cargo test --workspace --locked -j2
cargo test -p kinshoko-core --test catalog_approx --test catalog_groups --test catalog_visibility --test portable_tags --test tag_catalog --test workspace --locked -j2
cargo clippy --workspace --all-targets --locked -j2 -- -D warnings
cargo fmt --all --check
npm test
npm test -- src/library/TagIdentityPanel.test.tsx
npm run typecheck
npm run vite:build
$env:KINSHOKO_SKIP_AUTOSTART = '1'
node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --config work/t06/tauri.test.json
$env:KINSHOKO_WEBDRIVER_PORT = '4474'
node e2e/shared-personal-approx.mjs target/debug/kinshoko.exe <matching-msedgedriver> C:/Users/yuk1no/.cargo/bin/tauri-driver.exe
```

原始日志、source 清单、环境、设置与截图保存在 [本单证据目录](evidence/spec78-t06/)。`.gitattributes` 保留原始字节和空白；产品与文档继续检查空白。各文件 SHA256 在 `evidence-hashes.json`。

## 正式原生证明

[`shared-personal-approx.mjs`](../../e2e/shared-personal-approx.mjs) 使用冻结的 v16 schema 生成两份旧资料库和 7 份真实 PNG。所有规则动作与回读经过正式 UI 或公开 IPC。[成功结果](evidence/spec78-t06/native-result.json) 为 **30 项通过**，原始目录 `work/e2e/shared-approx-1791484030845/`。正式程序来源 `49c39e0c4a7df150183e48d27883e0c5fca82c9f`，tree `b6833db6e1297d0121245a86c46620d9f852a310`，脚本实际来源 `3a3c4fbfc579c12d487dbcc5ab60afb2a3fbe374`。二进制 SHA256 `aae236fd854c72221dfdd5b95b59e27d016c49314fb25621d542ecf10a47a3a7`，原件与 DirectML／配置保留在 `work/t06/nativeproof/49c39e0/`。

[原始源码清单](evidence/spec78-t06/native-source.json) 绑定 473 个源码／配置文件、实际 dist、DirectML 与 driver 哈希。[最终匹配检查](evidence/spec78-t06/native-source-match.json) 在合入最新整合后确认：全部产品源码、dist、运行时、构建配置及 binary 匹配；唯一源码清单差异是 `TagIdentityPanel.test.tsx` 的 test-only 清理。没有改写文件去强配哈希，没有把后续文档提交冒充原生编译来源。

实际步骤覆盖：正式打开两份 v16 库；相反旧判断保持未决并显示双方来源；设置明确选择相近；查找显示可见相近 chip，来源标记默认关闭；“只这次”不改长期判断，重新查找恢复；“以后都不展开”保存全局不相近并压过内置；“＋”保存无外部对应的标签；相同全局规则分别转换到两库不同本地 ID；正式切换活动库后判断不变；精确／排除语义保持；正式设置删除相近规则后正常重启，删除与不相近均保持；关闭安全模式仍能读取原隐藏定义，回到安全模式立即撤销标签；断开最后活动库后，其他 provider 仍可用，设置仍能删除迁移规则；正常重启后旧库不重新带回规则，内置展开恢复。7 份原文件 SHA256 均不变。两个新增 IPC 在真实 WebView 权限下执行成功。

[`native-tray-exit-t06.py`](../../e2e/native-tray-exit-t06.py) 限制本工作树精确 exe 路径、唯一实际 PID、fresh 原生 popup、menu owner 与读取到的“退出”ID。成功流程五次进入普通菜单回调，receipt 均为 `processEnded=true`、exitCode 0。通过路径没有使用 WM_QUIT 或强杀替代正常退出。失败清理仅针对本 exe 和本次 driver PID。WebView 的 class unregister 1412 清理日志没有改变正常退出结果。

[第一轮失败](evidence/spec78-t06/native-first-result.json) 原始目录 `work/e2e/shared-approx-1791483912961/`，在 14 项通过后等待活动库 picker 超时。fixture 通过 IPC 登记，但脚本没有让 App 重新加载活动库 props，DOM 中登记列表仍空。脚本按既有 T05 方法在初次登记后正常退出／重启，不改产品或 binary；第二轮完整通过。第一轮 DOM、截图、结果与日志保留，失败清理不算正常退出。

独立 identifier `dev.kinshoko.spec78t06test`，端口 4474／4475，`KINSHOKO_SKIP_AUTOSTART=1`。设备数据、资料库和 WebView profile 位于各次运行目录。Windows KnownFolder API 仍把壳设置放在 `C:/Users/yuk1no/AppData/Roaming/dev.kinshoko.spec78t06test/settings.json`；本单单独保存两轮实际设置，没有声称 APPDATA 覆盖隔离了全部设置。生产 identifier 未使用。[桌面清点](evidence/spec78-t06/desktop-release.json) 确认本单 app、两种 driver、两轮 profile／identifier 的 WebView 和端口监听均为空，根代理已释放桌面。

已静态查看 [双方旧来源与明确选择](evidence/spec78-t06/pending-two-provider-conflict.png)、[正式可见展开](evidence/spec78-t06/shared-similar-visible-search.png)、[无外部对应相近标签](evidence/spec78-t06/plus-unmapped-shared-rule.png)、[无活动库的规则管理](evidence/spec78-t06/no-active-provider-rule-settings.png)。真实 WebView viewport 为 1281×801，`devicePixelRatio=1.1041666269302368`，详见成功结果；这只记录实际 WebView 值，不推断系统 DPI 或多屏行为。

## 未验证

开发者实际安装环境和真实旧库的人工验收未执行。自动原生操作不等于人工体验认可。Windows 10 没有设备／虚拟机，用户已接受保留未验证状态。系统 DPI、多显示器、笔输入和广色域硬件不在本单已执行范围。T13 的完整程序设置备份／恢复由后续工单实现。
