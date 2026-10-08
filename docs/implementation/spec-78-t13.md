# #78 T13 / #92 程序设置备份

本单实现故事 33、34、36。公开核心与正式原生验证已执行。独立合并复核由根任务另行执行。
本单不继承前置 #42 / #71 的完成状态，不修改其记录。
精确实现起点：`b190770fc3d004c6f4fa101af1ff29cf8871b28f`。分支：`codex/spec-78-t13`。

## 实现

正式设置增加独立的“程序设置备份”入口。参考 `prototype/reference-browser/src/components/SettingsDialog.tsx` 的 fieldset/actions，接入正式公开核心动作。文件扩展名为 `.kinshoko-settings`。T12 的“资料库备份”保留独立入口和范围。

读取兼容备份后显示替换范围，再由使用者执行替换。预览记录文件 SHA-256；文件变化后拒绝旧确认。名称偏好、应用词表、分组顺序及成员、个人近似判断与删除记录、程序配置默认替换。不导入设备资料库位置，不写原图或逐图整理。

包从完整原始目录读取，不使用安全模式过滤后的 UI 视图。携带统一标签定义、外部词条实际所有者、显式名称偏好、名称接管/旧名确认、别名删除记录、分组迁移空目标、近似规则迁移确认与空判断。显式偏好等于默认名称时仍保存。当前资料库的本地 ID→统一 ID 含义保留；缺席的当前名称偏好清除。当前内容所需的纯定义依赖保留。

发布配置前写持久撤销 journal。目录在一个 SQLite 事务内替换。壳设置经同目录临时文件写入、sync、rename。发布后删除 journal。发生错误时回退。异常退出后，在 library 插件启动早期、读取模型与壳设置之前恢复完整旧配置。恢复可以重试。journal 保存完整本机旧状态；可携带的设置包不包含历史资料库根路径。

恢复刷新快捷键注册、模型选择、使用日志开关、安全模式、查找缓存与 workspace。目录请求代次在发布前后递增。参考截图来源、进行中的截图与逐张钉图显示授权失效。强制 sRGB 明确要求从托盘退出并重启。

查看器背景纳入程序设置。兼容四种旧 localStorage 值：dark/mid/light/checker。直接备份而尚未打开查看器时也迁移。核心有值后旧缓存不能覆盖。无背景的旧设置包恢复为 Mid。首次读取失败不将旧缓存写回。按库滚动锚点仍为本设备定位。

## 核心与前端证据

原始证据保存在本物理树 ignored `work/t13/`。根任务另行归档；不依赖前置任务的证据完成本单。

`crates/kinshoko-core/tests/application_settings_backup.rs` 有 7 个公开集成测试和 1 个子进程入口。入口标记 ignored，由父测试实际执行。3 个 journal/目录/壳设置发布点各执行 crash 与 error，共 6 个真实故障场景。crash 退出 99；error 注入 SQLITE_FULL。另有实际 settings.json 目标变成目录所产生的 rename 写入失败。

测试覆盖空白恢复、完整定义依赖、默认同值显式偏好、替换不合并、别名 tombstone、旧组/规则删除后重连不复活、当前绑定、逐图备注/标签/分级/目录及原图 hash、输入版本与预览指纹、外部词条所有权。原型只作体验对照。

早期 `name-red.txt`、部分 `rules-red*.txt` 和 `bindings-red.txt` 含测试夹具或编译修正，不能算产品 RED。有效产品 RED 为 `name-red-valid.txt`、`rules-red-product.txt`、`bindings-red-product.txt`、`write-failure-red.txt`、`crash-red.txt`、`external-owner-red.txt`。对应 GREEN 均保留，最终核心日志为 `external-owner-green.txt`。

前端入口产品 RED 为 `ui-red.txt`，交互 GREEN 为 `ui-green.txt`。背景读取失败写回旧值的产品 RED 为 `viewer-background-red.txt`，GREEN 为 `viewer-background-green.txt`。前端测试只补充交互合同，不代替正式程序。

精确验证来源：

| 来源 | 结果 | 原始记录 |
| --- | --- | --- |
| T13 实现工作区、合入 T10 前（未冻结源码清单） | 全 Rust workspace，659 个父测试成功、10 个 ignored 入口；父测试另执行真实故障子进程 | `work/t13/rust-workspace.txt` |
| 固定产品 `5a48939e905652b9d15a4a5f47a0844012e7a8f7` | T13 核心 7 项成功、6 个实际故障子进程完成 | `work/t13/after-8fc-core.txt` |
| 同一固定产品 | fmt、strict clippy `--workspace --all-targets -- -D warnings`、TypeScript 成功 | `work/t13/after-8fc-{fmt,clippy,types}.txt` |
| 同一固定产品 | 前端 34 文件、269 项成功 | `work/t13/after-8fc-ui.txt` |

全 Rust 计数按每个 Cargo target 的最后一条汇总计算，排除嵌入的子进程汇总。`work/t13/checks.json` 保存计数来源。未将合并前全 workspace 的结果称为合并后全量结果。

## 正式原生验证

开发者本机：Windows 11 Professional 26H2（26300.9550），WebView2 154.0.4258.62，实际 DPR 1.1041666269302368。诊断记录在成功 run 的 `restarted-diagnostics.txt`。

固定产品源码：`5a48939e905652b9d15a4a5f47a0844012e7a8f7`。
固定产品 tree：`d8a88fa33bacd02512149e689e7defd1666a512a`。
EXE SHA-256：`2c9e5a69eee742519ba08ec194662614f2da5b29cb5b68cad12149b14b2102df`。
固定 EXE 与 DirectML.dll 位于 `work/t13/nativeproof/5a48939e9056/`。
成功 harness 来源：`99a7fd5735fd758d3cc78ed308e65f551094c76d`。

`work/t13/native-source.json` 保存 1034 个 source 文件、10 个 dist 文件、配置和两个 driver/runtime 的哈希。`work/t13/native-after.json` 比较前后清单：仅两份预报过的验收脚本变化，production source、嵌入前端和冻结 EXE 未变。三次重试均只修改 harness。

隔离标识为 `dev.kinshoko.spec78t13test`。端口 4492/4493。资料库、应用数据和 WebView profile 在每次新建的 `work/e2e/application-settings-<timestamp>/`。KnownFolder 实际配置是 `C:/Users/yuk1no/AppData/Roaming/dev.kinshoko.spec78t13test/settings.json`；不将 APPDATA 环境覆盖误认为实际配置重定向。结束后配置原件移入各 run；不覆盖使用者配置。

成功 run：`work/e2e/application-settings-1791488008375/`。`result.json` 为 passed，共 47 项断言。脚本使用正式备份/确认/替换控件，公开 IPC 准备与读回受控的真实旧库夹具。没有新增测试专用生产 IPC。

已执行：

- 尚未打开查看器时，直接备份迁移旧背景。
- 正式界面明确读取和确认替换范围；已有配置被替换，缺席偏好及旧组删除不被合并回来。
- 当前 provider 本地 ID 含义、逐图资料及六份原图 SHA-256 保持。
- 同一安全模式下并发的 48 个真实目录请求全部被拒绝。完整响应保存在 `in-flight-results.json`。
- 真实系统 Ctrl+Alt+F9 触发原生截图；旧 Ctrl+Alt+F10 不再触发。SendInput 先核对精确可执行文件、唯一 PID、前台窗口所属 PID 和按键状态，并记录回执。
- 恢复后的使用日志在本次运行记录 captureStarted。模型选择和安全模式在当前运行采用恢复值。
- 正常托盘退出后重新启动，force sRGB 保存值与本次采用值均为 true；诊断记录与 UI 读回一致。此项不代替色彩还原度实验。
- 实际重新打开查看器，背景选项和舞台为棋盘格；陈旧 dark localStorage 被替换为 checker。
- 旧库全部离线时，空白应用恢复完整定义且没有导入设备资料库登记。旧库重连后，两库共用名称与个人近似选择，已删除的旧分组不复活。
- 实际原生进程在 settings_restore_after_catalog 退出 99，持久 journal 保留。下一次启动恢复完整旧名称/分组/背景并消费 journal，然后从正式界面再次恢复成功。
- 7 次正常托盘退出的原生菜单回执均为退出码 0。故障退出码 99 单独记录，不算正常重启。

失败原件保持：

| run | 原因与边界 |
| --- | --- |
| `1791487683935` | 夹具把自动命名空间分组当作可编辑分组；正式接口正确拒绝。不是产品 RED。 |
| `1791487736380` | WebDriver 按键没有触发 Windows 系统热键。改用经过 owned PID/前台窗口核对的真实 SendInput 后，正反按键行为得到验证。该轮热键断言不能作为系统注册证明。 |
| `1791487887025` | 实际故障退出已为 99，但脚本抢读刚创建而未写完的 JSON 回执。改为等完整回执。不能将该轮算完整恢复成功。 |

`work/t13/screenshots.json` 限定各截图的证明范围。`restored-viewer-background.png` 只证明背景选项与舞台棋盘格；图片仍在加载，不能据此证明原图已显示，也不证明截图像素链路。

`work/t13/native-release.json` 在 2026-10-08 19:34:53 UTC 记录精确自有 EXE、driver、WebView 和两个端口均为空。KnownFolder settings 已归档并不存在。桌面已交还根任务。

## 限制与后续集成

Windows 10 未验证；负责人明确保留此状态。debug 验证按既有实现不写系统自启登记；本单验证自启配置往返，未验证 release 的系统自启登记。没有新增 unsafe。截图像素链路与最终组合显示验收由对应独立工单继续处理。

根任务确认 T12 稳定 tip 后再合入。本单固定原生结果只归属于上述 5a 产品及实际 harness 来源。最终集成的受影响检查另列，不把旧 EXE 的结果冒充为新源码完整原生结果。
