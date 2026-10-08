# #78 T05：全局标签分组

本单对应 #84、故事 28／29。用户整理一次分组后，在各资料库共用。分组展开为可见成员的任一条件，图片的标签与原文件保持原样。

这是独立增量。复用前置代码基线 `536cc43c1933e44fc33836f8a439de8cdb0da018`，没有改写 #42／PR #71 或旧验收状态。分支 `codex/spec-78-t05` 从集成 `16c8760e016be0a8e1bcc9d97ac362b8feab9c7d` 开始，实际工作树为已结束 T04 的 managed tree `spec78-t02-tag-identity/kinshoko`，未清理旧 ignored 证据。已合入 T08 `748e4c62e6db8e2b4e7b92db4f92597c182bf976`、T09 `23867c1755840821f44493448e3148d55b621190` 和最新集成的文档提交 `fad93218cc56ee31b77460e1b4ef0b1d8127ab3b`。

## 核心行为与持久状态

[`tag_catalog/groups.rs`](../../crates/kinshoko-core/src/tag_catalog/groups.rs) 承担分组创建、改名、删除、分组排序、成员添加／移除／排序。分组与成员持久保存在应用的统一标签目录。成员使用统一身份；查找时通过已有 Workspace 的统一身份转换，分别转换为各来源的库内 ID。

显式成员分组保留用户顺序。命名空间分组动态列出该类可见身份，继续区分同名作品、作者等身份。没有给图片增加分组属性，没有通过分组操作写入图片标签。

统一目录 schema 升至 4：`catalog_group`、`catalog_group_member`、`catalog_group_migration`。本单不新增内容库 schema。旧库中的原始分组名称、命名空间、库内成员顺序和来源库身份保存在独立来源记录。每个 `(library_id, group_id)` 迁移一次；同名来源生成不同应用分组，打开顺序不会覆盖成员。迁移不回写旧库。

删除分组后，迁移记录仍在，`target=None`。重新打开未更改的旧库不会恢复已删除分组。来源记录和用户当前分组定义分别保存，用户之后改名或修改成员不会改写来源历史。

[`TagCatalog::group_definitions()` 和 `group_migrations()`](../../crates/kinshoko-core/src/tag_catalog/groups.rs) 是后续 T13 程序设置备份的公开核心接口。前者返回当前有序分组、完整统一成员和原始来源；后者包括指向存活分组的迁移记录及删除记忆。T13 应同时保存／替换两者及必要的统一身份，避免设置恢复后旧库重新迁移。它们属于程序设置，不能加入资料库内容备份。本单未实现 T13 的导入／原子替换动作。

普通 UI 只接收 `CatalogGroupView`。来源仅含库名、旧分组名及身份，不含原始隐藏成员 ID、文字或数量。`CatalogGroupDefinition` 和全量迁移历史不暴露为普通 IPC。

## 安全视角与组合回归

全局分组通过 Workspace 的所有已知来源判断可见性。同字节图片只要任一来源为 Adult，安全模式就隐藏其专用成员；未命中查询、范围外、已知离线来源也参与否决。读取使用独立只读 provider，不改活动库的安全模式。

安全模式下的合法改名、排序、添加／移除可见成员，保留所有未返回的隐藏成员。不能用过滤后的成员列表替换完整成员。显式提交隐藏 ID 的非法编辑整次事务失败，不留下先处理项目的部分写入。

根代理额外用公开接口复现 `A Adult / B Unknown` 同文件时，普通名称设置仍暴露 B 专用标签的问题。本单接入原 RED 后修复：`TagCatalog::inspect_libraries` 复用同应用目录的 Workspace 持久事实；名称设置、迁移向导、分组管理使用同一可见规则。可见性只过滤返回投影，不删除原始目录。未使用的合法定义仍可管理；同一标签还有可见图片使用时保留，计数只包含可见非回收站图片。搜索候选继续使用实际有效图片，管理分组另保留合法零使用定义。

## 正式界面与原型

直接读取并适配固定认可 `bd8aea44c4a311571ee3c07382cb7755f87f3153` 的 [`TagGroupBar.tsx`](../../prototype/reference-browser/src/components/TagGroupBar.tsx)：保留标签弹层、计数、点击／Ctrl 点击／右键条件手势，增加明确的“任一成员”整组查找动作。认可基线未改动。

正式 [`TagGroupsPane`](../../src/library/TagGroupsPane.tsx) 同时用于侧栏与程序设置。显示旧库来源、明确的改名／删除／排序动作、成员顺序和工作区标签选择。设置中的全局分组不要求活动库，空分组也能改名。模式或工作区代次变化清空旧视图，拒绝迟到响应；同一视角内刷新期间保留已显示结果。

三个新 IPC `shared_tag_groups`、`create_shared_tag_group`、`edit_shared_tag_group` 在前端、handler 与 `src-tauri/build.rs` inline commands 一致登记，沿用 `library:default`。Tauri 只适配核心动作、安全模式代次与工作区状态。

## 独立 RED → GREEN

应用 TDD 技能。核心检查调用公开动作，创建真实 SQLite 与真 PNG；没有以私表断言替代业务验收。

| 场景 | 实现前失败 | 通过证据 |
| --- | --- | --- |
| A 的旧组在 B 活动时可用、重开与图片标签不变 | 返回 0 组，预期 1 | `core-red.log` → `core-seven-green.log` |
| 无活动库创建与持久化 | 公开动作返回 UnknownGroup | `create-red.log` → `create-green.log` |
| 分组与成员管理／排序 | 公开动作返回 UnknownGroup | `organize-red.log` → `organize-green.log` |
| 两库 OR、缺失映射、同名迁移、删除记忆、动态命名空间／当前名称 | 在前述公开行为 RED 后增量实现 | `catalog-visibility-green.log` |
| 安全模式合法编辑保留隐藏成员、非法批量编辑原子失败 | 沿用首次全局组 RED；另补正向往返 | `core-safe-edit-roundtrip.log`、最终核心检查 |
| 正式设置无活动库、来源／排序、迟到视图与认可弹层 OR | 新组件或操作缺失 | `frontend-red.log` → `frontend-regression-03.log` |
| 名称设置与分组的全来源 Adult 规则／未使用定义 | 封印专用词泄露；未使用成员返回 UnknownTag | `catalog-visibility-red.log` → `catalog-visibility-green.log` |

新增公开核心检查 9 项：`catalog_groups.rs` 7 项，`catalog_visibility.rs` 2 项。新增前端分组检查 5 项，现有分组检查 11 项适配全局 IPC。完整前端首轮 247／248，标签对应 fixture 捕获的旧控件未及时更新；补等待实际可点击状态并重新查询当前行，完整复跑 31 文件 248 项通过。原始失败日志保留，未把首轮说成通过。另补同修订监测通知的公开 UI RED：改名输入框消失。正式设置先取得实际保存的安全模式与工作区修订，再显示编辑器；相同修订不清空草稿。新增检查通过，见 `group-settings-revision-red.log`／`group-settings-revision-green.log`。

## 实际检查与来源

2026-10-09（Asia/Shanghai），Windows 11 专业版 `10.0.26300`，Rust `1.95.0`，Node `v22.15.0`，WebView2／EdgeDriver `154.0.4258.62`，tauri-driver `2.1.0`。Cargo 只使用本工作树 `target`，并发 2。

| 检查 | 实际范围与结果 |
| --- | --- |
| 修复组合可见性后的完整 Rust 工作区 | 通过，`workspace-tests-final.log`；之后 T09 合入只补受影响范围 |
| 合入 T09 后的核心 | 分组 7、组合可见性 2、明确来源动作 4、工作区 7，共 20 项通过 |
| 完整前端 | 31 文件 248 项通过，早于之后增加的同修订草稿回归与 T09 合入 |
| 草稿修复的设置／分组专项 | 3 文件 30 项通过，含新增第 5 项分组行为 |
| 合入 T09 后受影响前端 | 5 文件 94 项通过：App、明确来源、共享分组、既有分组、设置 |
| TypeScript／Vite | 合入 T09 后通过；实际嵌入 dist 固定在 native source 清单 |
| Clippy／fmt | 合入 T09 后 all-targets 严格检查与格式通过 |
| 原生构建 | 本树独立 identifier 构建通过，1m11s；只在构建后修改验收脚本与文档 |
| 完整原生流程／草稿补验 | 27 项／5 项通过；分别记录自己的实际脚本来源 |

Clippy 首轮两处测试的多余 clone 告警已修复，原日志保留。最初版本采集调用 `tauri-driver --version` 被 CLI 拒绝，没有启动 driver 服务；最终版本从 `cargo install --list` 记录。不能把版本采集失败说成 Cargo 构建失败。

实际命令和原始输出在本单 [证据目录](evidence/spec78-t05/)：

```powershell
$env:CARGO_BUILD_JOBS = '2'
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
cargo test --workspace --locked -j2
cargo test -p kinshoko-core --test catalog_groups --test catalog_visibility --test workspace --test source_actions --locked -j2
cargo clippy --workspace --all-targets --locked -j2 -- -D warnings
cargo fmt --all --check
npm test
npm test -- src/App.test.tsx src/library/WorkspaceSources.test.tsx src/library/SharedTagGroups.test.tsx src/library/TagOrganize.test.tsx src/SettingsPanel.test.tsx
npm run typecheck
npm run vite:build
$env:TAURI_CONFIG = '{"identifier":"dev.kinshoko.spec78t05test"}'
cargo build -p kinshoko --features tauri/custom-protocol --locked -j2
node e2e/shared-tag-groups.mjs target/debug/kinshoko.exe <matching-msedgedriver> C:/Users/yuk1no/.cargo/bin/tauri-driver.exe
node e2e/shared-group-draft.mjs target/debug/kinshoko.exe <matching-msedgedriver> work/e2e/shared-groups-1791480727533 C:/Users/yuk1no/.cargo/bin/tauri-driver.exe
```

## 原生正式程序

[`shared-tag-groups.mjs`](../../e2e/shared-tag-groups.mjs) 创建冻结 v16 schema、真实 PNG、两份旧库。全部组动作通过正式 UI 或公开 IPC 执行。[完整结果](evidence/spec78-t05/native-result.json) **27 项通过**，实际运行目录 `work/e2e/shared-groups-1791480727533/`。

实际产品来源 `f7ef52b12681ed679927f7fef034629b923ae8ec`，包含 T08 和 T09；通过流程的脚本来源 `77870f5e40ee47afe467f58bb00496afbed11a23`。二进制 SHA256 `7dca4915d39d648f5b0e7b615671d316b3e63b187ee97a44d4cbb2f8ed3ff239`，原件在 `work/t05/nativeproof/f7ef52b1/kinshoko.exe`。[源码清单](evidence/spec78-t05/native-source.json) 记录 360 个源码／配置文件、10 个 dist 文件、sidecar 与 driver 哈希。[最终匹配检查](evidence/spec78-t05/native-source-match.json) 确认后续脚本与文档提交没有改变这些产品文件。 `native-source.json.harnessCommit` 是首次准备构建时的 `2acd42963a04e9920dc1ece6b6fd69dbb1f194b4`，不代表之后通过的完整脚本或草稿脚本；两轮实际来源分别记录在各自 result 中。

实际步骤包括：正式打开两份真旧 v16 库；同名不同成员的分组分别保留来源；在设置改名、添加跨库成员、排序成员和分组；认可弹层展开一条可见 OR 条件；正式切换两库后统一成员及顺序不变；明确来源查询转换成不同的本地 ID；安全模式隐藏同字节 Adult 的专用成员，合法改名／添加／移除／排序后关闭安全模式仍能读到原隐藏成员；普通名称设置和旧名向导也不泄露该词；删除旧组、修改名称偏好后正常重启，删除记忆与当前名称保留；动态作品组不混入同名作者；断开最后活动库后，正式界面没有活动库，其他 provider 可用，设置仍能创建和改名空组，并经正常重启保留；五份原文件哈希全部不变。三个新增 IPC 在真实 WebView 权限下都执行成功。

[`shared-group-draft.mjs`](../../e2e/shared-group-draft.mjs) 只补草稿与焦点，**5 项通过**。它复制完整通过轮已关闭的 app-data 到独立目录，不改写前一轮报告。产品与二进制相同，脚本来源 `125a58f76e268e3d9e1dec9ccec70fca9f6c0477`。正式输入“跨周期整理完成”，实际等待 **2310ms**；前后 workspace revision 相同，输入文字和键盘焦点均保持；按 Enter 经公开动作保存成功。见 [补验结果](evidence/spec78-t05/native-draft-result.json) 与 [实际输入截图](evidence/spec78-t05/rename-draft-after-monitor-period.png)。这不把首轮未执行的检查算作通过。

[`native-tray-exit-t05.py`](../../e2e/native-tray-exit-t05.py) 复用前置验证过的正常退出方法，限制本树精确绝对 exe 路径和唯一实际 PID。每次读取 fresh 原生托盘菜单、owner、“退出”的文字／状态／ID，收起菜单后进入普通菜单回调。完整流程五次退出和草稿补验一次退出，receipt 均为 `processEnded=true`、退出码 0，没有用 WM_QUIT 或强杀替代通过路径的正常退出。失败路径的清理只针对本树 exe 与本次 driver PID。WebView 清理的 class unregister 1412 日志没有改变实际正常退出结果。

独立 identifier `dev.kinshoko.spec78t05test`，端口 4464／4465，`KINSHOKO_SKIP_AUTOSTART=1`。设备目录、资料库与 WebView profile 在本次运行目录。Windows 已知目录 API 仍把壳设置放在 `AppData/Roaming/dev.kinshoko.spec78t05test`；不声称 APPDATA 覆盖隔离了全部设置。生产 identifier 未使用。[桌面清点](evidence/spec78-t05/desktop-release.json) 确认本单程序、两类独立 WebView、driver 和端口监听均为空，桌面已释放。

前三轮失败保留原状：[第一轮](evidence/spec78-t05/native-first-result.json) 在安全模式变化后过早找控件；第二轮把 `current_library` 的明确断连错误误当应返回 null；第三轮在正常退出后的新 WebDriver 会话创建时遇到内部 JSON EOF，未进入余下产品断言。最终脚本等待实际控件，核对断连错误及界面无活动库；第四轮同一产品完整通过。没有把这些失败改写为成功。

已查看旧组来源、分组排序、OR 条件和草稿截图。`no-active-library-global-settings.png` 抓在改名后组数据重新加载期间，不用它证明最终显示；无活动库下的正式创建／改名动作、公开回读和正常重启持久化由脚本实际完成。完整原始目录保留供复核。 根代理另存了五个原始运行、日志、固定程序／DirectML、脚本和实际 KnownFolder 设置，共 155 文件、122883624 字节。见 [根保存清单](evidence/spec78-t05/root-preservation.json)，实际副本在根工作树 `work/v1-handoff/follow-up-spec/evidence/t05-native/`。

## 未验证

开发者实际安装环境和真实旧库的人工验收未执行。自动原生操作不等于人工体验认可。Windows 10 没有设备／虚拟机，用户已接受保留未验证状态。实际系统 DPI、多显示器、笔输入和广色域硬件不在本单已执行范围。T13 程序设置恢复由后续工单实现。
