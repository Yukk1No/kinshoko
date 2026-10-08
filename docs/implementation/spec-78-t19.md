# #78 T19：私有安装包更新与公开阶段门槛

关联：[规格 #78](https://github.com/Yukk1No/kinshoko/issues/78) 故事 50；[工单 #97](https://github.com/Yukk1No/kinshoko/issues/97)。本记录独立于 #42、#70、PR #71 与历史验收，不继承其通过状态。

## 结果与来源

核心阶段控制、正式更新界面、编译和 lint 通过。真实旧版到新版 NSIS 安装升级 25 项通过；两版经真实托盘菜单正常退出，登记、设置、参考组和持久钉图完整恢复。公开签名自动更新仍由 #99 单独验收。

- 实现起点：`20bded04927fdb6ffec2c292d22654003034740f`。
- 首次实现提交：`ddabe2b384a69c24d35dfd48f4294d76a7026bc2`，先通过公开核心和前端红绿验证，再提交产品源码。
- 合入 T03：`df31f33`，包含集成 `29433ed89f5dc1c8caed31e3362b38c99cc87117`。保留其新增名称刷新测试，相关前端 19 项通过。
- 新包产品源码：`5082f317b6a48c1ddf1dabeb1cbdc4e23fa11193`，含 lint 等价表达式修正。
- 旧包产品源码：固定基线 `536cc43c1933e44fc33836f8a439de8cdb0da018`。
- 原生完成后合入最新集成 `71e635dabe38ff4e7ef55695088addd8bfa9881b`（T07），合并提交 `fce6fc7e04a9767455e15ef06a61db2e411e8b8d`。原生包未为这次后合组合重建；本单不把 `5082f31` 包的通过回填为最终组合通过，组合由 T20 承接。

阅读并对照固定 `bd8aea44c4a311571ee3c07382cb7755f87f3153` 的实际原型 `prototype/reference-browser/src/components/SettingsDialog.tsx`。原型没有安装更新业务；本单在 T01 已接入的正式设置结构中扩展现有 `UpdateSection`，保留设置段落、提示样式和原更新提示行为。没有修改认可原型，也没有用原型状态代替真实存储。

## 实现

`kinshoko-core::UpdatePolicy` 统一控制自动检查和安装。构建默认 `plugins.updater.releaseStage = private`；兼容配置缺少阶段时同样按私有阶段处理。返回 `manual` 状态和安装包更新说明，不进入更新请求。

公开阶段必须明确为 `public`，公钥非空且更新入口恰为原仓库 `Yukk1No/kinshoko` 的 `latest.json`。缺少条件或阶段无法识别时返回 `disabled` 与具体原因。检查和安装每次重新应用同一策略，并清除不再适用的待安装对象。

正式设置页显示私有手动更新步骤，或公开构建未启用的原因。主窗口仍只在 `unchecked` 时自动检查。符合条件的公开构建继续使用原 Tauri updater、原仓库签名管线、下载进度、签名失败提示及 `on_before_exit → desktop::on_exit` 保存边界。没有新增更新下载器或发布仓库。

当前安装说明见 [安装](../install.md)，发布者的明确阶段条件见 [更新阶段](../update-stages.md)。历史发布清单保持原文；其中另建发布仓库的备选不适用于 #78。

## 红灯与自动验证

测试边界沿用本轮已确认的公开核心动作、正式前端及原生程序入口。核心无 Tauri 依赖；没有查询私有表或添加测试专用存储入口。

| 验证 | 结果 | 证据 |
|---|---|---|
| 私有阶段核心红灯 | 新策略/手动状态尚不存在，编译失败 | `policy-private-red.txt` |
| 私有阶段核心绿灯 | 配有公钥仍要求手动更新 | `policy-private-green.txt` |
| 公开阶段核心红灯 | 公开条件完整仍被初始私有策略阻挡 | `policy-public-red.txt` |
| 最终核心行为 | 3 项通过；覆盖私有、缺阶段、未知阶段、完整公开条件、缺公钥、缺原入口和其他后备入口 | `policy-after-lint.txt` |
| 私有设置页红灯 | 未显示手动说明，仍有检查按钮 | `ui-private-red.txt` |
| 禁用原因红灯 | 仍只显示无原因的通用文案 | `ui-disabled-red.txt` |
| 更新/设置前端 | 合 T03 后 19 项通过，保留原新版提示、安装按钮和收起提示 | `post-t03-ui.txt` |
| TypeScript | `npm run typecheck` 通过 | `post-t03-typecheck.txt` |
| Tauri 命令层 | `cargo check -p kinshoko -j2` 通过 | `tauri-check.txt` |
| Lint | `cargo clippy -p kinshoko-core -p kinshoko --all-targets -j2 -- -D warnings` 通过；最初布尔表达式提示已修正 | `clippy-final.txt` |
| Rust IPC 类型 | `app_shell` 3 个导出测试通过，更新生成的 `UpdateStatus.ts` | `policy-bindings.txt` |
| 合最新集成后的前端 | Update/Settings/App/bootstrap 79 项通过，TypeScript 通过 | `post-integration-ui.txt` / `post-integration-typecheck.txt` |
| 合最新集成后的 Rust | 核心阶段策略 3 项通过；core/Tauri 全 targets Clippy deny warnings 通过 | `post-integration-policy.txt` / `post-integration-clippy.txt` |

上述证据位于 [evidence/spec78-t19](evidence/spec78-t19/)。构建使用 `CARGO_BUILD_JOBS=2` 及本工作树独立 `target`。只共享依赖缓存，未使用其他树的 workspace 产物。

## 真实隔离安装升级

通过。完成时间为 `2026-10-08T16:20:43.185Z`（本地 10 月 9 日 00:20）。最终独立样本为 `run-1791476426862`，`report.json` 记录 25 项实际检查，不回填之前失败样本。

`e2e/private-upgrade.mjs` 先运行真实旧 NSIS 包，以正式界面建立资料库、导入自制 512×320 PNG，再以公开 IPC 设置非默认选项、快捷键、参考组和真实钉图。旧应用从真实托盘菜单正常退出后，直接在同一安装目录运行真实新包 `/S /UPDATE /D=<原目录>`，未先卸载旧产品。两次安装均退出 0，安装前 RestartManager 对目标 exe 的占用者为空。

新版启动后完整比较资料库登记和最后打开位置、非默认设置/快捷键、参考组成员/来源/裁剪/变换、钉图身份/成员关系/来源/裁剪/位置/缩放/翻转/旋转/透明度/锁定、safe mode，并读取真实旧 SQLite 库中的原图。参考图实际可解析，未被 unavailable 或 veiled 标记。正式设置页显示手动更新且无自动检查/安装按钮；实际 `check_update` 返回 manual，`install_update` 在命令边界拒绝。新版再次正常退出后，只卸载该独立测试产品。

正常退出使用 `e2e/native-tray-exit.py` 的 `automated-native-menu-dispatch`：每次核对唯一独立 exe PID/path、fresh tray/popup、popup owner 与末项“退出”实际 id，收起该菜单后分发正常 WM_COMMAND，进入生产 `muda → backup::quit → RunEvent::Exit → desktop::on_exit`。两版实际进程均结束，退出码 0。它不是人工点击，也不发送 WM_QUIT、调用私有退出命令或强杀应用。独立 driver 的清理发生在 app 退出之后。`desktop-release.json` 确认本单 app/driver/WebView 无残留，4534/4535 无监听；已释放原生桌面。

| 项目 | 旧包 | 新包 |
|---|---|---|
| 源码 | `536cc43c1933e44fc33836f8a439de8cdb0da018` | `5082f317b6a48c1ddf1dabeb1cbdc4e23fa11193` |
| 测试安装包版本 | `0.1.0` | `0.1.1` |
| workspace 源码版本 | `0.1.0` | `0.1.0` |
| 安装包 SHA256 | `b1ee1339bbc0e9e2981d50f6519409aab81b73f3574504a857a6fd0afb2a8e91` | `f480139602bba172c657554ceff87028be6c64fc457af1d344a7ad6d36175dec` |
| 打包后恢复的 target exe SHA256 | `67caca7581021f68156a093adfa2f830d17038790f0389931758b45c4ffe0ccf` | `62ea84a1e3379775a73eb61568e18f0e55a20a297fb3d8837daa164b81934f8b` |
| NSIS 内实际安装 exe SHA256 | `8dfd1074c1fe51d9166316b0c0b68bcbe3cc9cae1b53da3cbff618bee85cca5f` | `3186f8a91de22aff88927187003bfde3056fbb0a8ae31cb69793f55a44f535df` |

两个包都是本树真实 `tauri build --debug --bundles nsis` 产物。NSIS 产品名同为 `Kinshoko T19 Upgrade Probe`，identifier 同为 `dev.kinshoko.spec78t19upgrade`，程序名同为 `kinshoko-t19-upgrade.exe`，安装目录位于本单 `work/native/t19-upgrade/installed`。独立程序名也隔离 NSIS 的运行进程检查。没有覆盖或卸载正式产品。

独立配置覆盖产品名、程序名、identifier、包版本、无 devUrl、关闭 updater 签名产物和 debug DirectML hook。新包 `0.1.1` 是测试包版本，用于执行真实 NSIS 版本升级；应用 core 的版本文字仍来自源码 workspace `0.1.0`，不能将其冒充正式版本发布。生产 hook 固定引用 release DLL；测试等价 hook 准确打包本树 `target/debug/DirectML.dll`，两包 DLL 哈希一致。未修改产品源码或生产签名配置。配置及 hook 的完整哈希见 `build-evidence.json`。

资料数据、WebView 用户目录、Roaming/Local 环境目录隔离，并设置 `KINSHOKO_SKIP_AUTOSTART=1`。原生端口使用 `4534/4535`。完整包、日志与临时真实资料保留在 ignored `work/native/t19-upgrade/`，不向 Git 提交安装包二进制。

源码与安装 exe 之间的哈希区别来自 [Tauri CLI v2.12.1 官方 bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle.rs)：打包时把首个 `__TAURI_BUNDLE_TYPE_VAR_UNK` 替换为 NSIS 的 `__TAURI_BUNDLE_TYPE_VAR_NSS`，打包后恢复 target exe。旧/新 token 偏移分别为 75418480 / 76014112，只变 3 字节；旧安装 exe 反向替换后恰等于独立记录的旧 target 哈希。最终 harness 校验实际 NSIS payload 哈希，不把已恢复 target 的哈希直接当安装 payload。

最终测试环境：Windows build `10.0.26300`、WebView2/msedgedriver `154.0.4258.62`，实际 `devicePixelRatio = 1.1041666269302368`。这只记录本次环境，不声称测试了指定系统缩放档位。设置页截图已检查，手动说明与步骤可见且没有自动更新操作。退出日志包含 WebView 的 class unregister 错误 1412；两次进程退出码均为 0，全部状态比较通过。

## 保留的失败与重试

- 首次安装前 provenance guard 错把恢复的 target exe 哈希当作 NSIS payload；旧包已实际安装，但尚未启动。保留 `report-provenance-red.json` 和对应日志，随后以官方 bundler 源码和实际字节证明修正 guard。
- 托盘观察工具返回 `Computer Use app approval timed out`。该轮 15 分钟退出等待超时，未记为正常退出。原生 End/Enter 消息未选择菜单，SendInput 的前台 PID guard 拒绝向其他窗口输入。第二轮仅 dispatch 菜单 id 未先收起模态菜单，也失败。原件与实际自动化方法见 `tray-automation-notes.md`。
- 第一次完成旧版正常退出后，新包仅用 `/S` 返回 2，旧 PE 仍为 `0.1.0`。根因未确认。保留 `report-new-silent-red.json` 与日志；未当作通过。随后在未卸载旧产品的情况下，以同一新包的 `/S /UPDATE` 重试成功，PE 版本变为 `0.1.1`、实际 payload 哈希匹配，记录在 `supported-update-retry.json`。最终又以官方支持的 `/UPDATE` 路径完整重跑新样本，两个安装器退出码 0，RestartManager 无占用，25 项全部通过。原 `/S` 失败不被后来的成功覆盖。

实际运行的三个 harness 的 SHA256 均由最终 `report.json` 记录。正式红绿、编译、构建、配置、hook、完整 before/after、托盘回执、截图、原生失败和成功日志已归档到 [evidence/spec78-t19](evidence/spec78-t19/)。安装器二进制与真实数据仍留在 ignored 工作证据目录。原始日志不改写；归档 `.txt` 仅规范换行、行尾空白和末尾空行，原件哈希见 `original-log-hashes.json`。


## 未验证与边界

- 真实公开仓库的更新清单、生产 Minisign 签名、下载与安装重启：未验证，由 #99 承接。核心配置检查和本地手动包不代表公开自动更新通过。
- 普通双击及交互安装向导：本单未验证。实际通过仅覆盖隔离 debug 包的 `/S /UPDATE` 真实安装入口，不外推全部安装方式；原 `/S` 返回 2 的根因仍未确认。产品界面的“运行新版安装包”是手动更新步骤，不代表本单已验证所有交互入口。
- release 安装包性能、颜色质量及干净无开发环境系统：未验证。本单 debug 包只验证功能升级和状态保留。
- Windows 10：未验证；负责人已确认当前没有测试环境。
- 实际系统 DPI、多显示器、笔输入、广色域和主观体验：本单没有新增结论，仍在对应验收范围。
- 没有公开仓库、发布 Release、合并 PR、操作 GitHub 或生成/配置生产签名私钥。
- 新版会执行既有及本轮资料库迁移。T14 迁移后的库被固定旧版拒绝；本单不把旧版重新安装或代码回退当作安全数据回退。
