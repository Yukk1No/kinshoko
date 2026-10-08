# #78 T09：明确来源的整理与持久引用

关联：[规格 #78](https://github.com/Yukk1No/kinshoko/issues/78) 故事 12、13；[工单 #88](https://github.com/Yukk1No/kinshoko/issues/88)。本记录是独立增量，不继承 #42、#70、PR #71 或历史验收的通过状态。

## 结果与来源

已实现明确来源的标签、备注、分级、文件夹归属、删除、钉图和参考组动作。已登记但未活动的资料库可以整理，不切换 current，也不改变 lastOpened。正式原生程序的 25 项检查通过。

- 分支：`codex/spec-78-t09`；物理树：`C:/Users/yuk1no/.codex/worktrees/spec78-t16-original-crop/kinshoko`。
- 实现起点：`921c712e5ac423ac32af5ef396243a63acfb21b3`。旧 T19 分支的 `17c8af502da72c3f383d81b8343660e757e2b4ab` 保留。
- 首次生产实现：`ce49ffd1da3218cc3dbc4c6b6f366726f3a34324`。
- 合入目录森林及旧名向导：`a875b3a3a2621f84fc8940d5cb4b37caafb455c9`，包含集成 `e13ea2b93eb50776a092d1779e16cee5beff0c7c`。
- 原生产品源码：`36cab7ebe379f4614de7768553492daab5f7ee5e`，包含最新集成 `748e4c62e6db8e2b4e7b92db4f92597c182bf976`。产品树为 `5253be6317a8f2bee7596e78bea21b3e24298cc3`。
- 实际通过脚本：`5bd6c20b05491fd1332824dcb8939acfbc375039` 的 `e2e/source-actions.mjs`。脚本 SHA256 单列于原生结果。
- 原生完成后的低影响界面整理：`32ef871ecf80ee0795af8a34b31134e84dabf8c8`。将两处长内部 ID 行移到 title，稳定引用不变。受影响界面 74 项和 TypeScript 通过；没有把 25 项原生结果改标为这次界面提交。

实际参考固定原稿 [资料库工作区](../../prototype/spec78-alignment/library-workspace.html) 的来源选择、独立备注和来源使用动作。正式界面适配 `WorkspaceSources`，并复用正式 `SelectionPanel`、`TagPanel`、删除预览、钉图与参考组存储。原稿没有修改，也不充当正式存储证据。

## 实现边界

`DeviceLibraries::write(library_id)` 每次核对登记路径及真实资料库 ID，复用 current 或按库缓存的可写句柄。成功取消登记时移除该缓存。现有短同步收藏入口 `with_collection` 复用同一入口，不另建一套临时写库逻辑。

核心 `WorkspaceSourceTarget` 保存 `libraryId / imageId / contentId`。前两者确定来源，最后一项是聚合卡片的字节身份校验。它不能用于寻找另一份副本来替代写入。`read_source`、`write_source`、`inspect_source`、`source_candidates` 和 `source_reference` 都以精确来源执行；登记失效、路径替换、字节身份变化及全已知来源的 Adult 否决均会拒绝动作。读取使用独立只读句柄，不更改活动库的安全视角。

Tauri 在 transition 锁下检查已保存安全模式及模式代次，再转发公开核心动作。新增七条命令同时登记于 `invoke_handler` 和 `src-tauri/build.rs` 的 inline plugin commands；默认权限由 `AllowAllCommands` 生成，主窗口使用 `library:default`。真实 WebView 已调用全部七条新增命令，静态清单没有替代原生检查。

来源面板操作前显示资料库名称与最短唯一路径后缀，完整路径保留在 title。同名库沿用 T08 的 `libraryPathHint`。单来源卡片也能进入整理。多来源必须先选择具体记录；标签候选保留该库本地 ID，并使用工作区的全来源安全过滤。各份整理不会被复制到同文件的其他库。

钉图保存所选 libraryId/imageId。加入参考组使用同一份具体原图引用，保留布局、原图尺寸和成员身份。查询、范围变化、重启、原库断连及永久删除都不会把 B 的引用重写为 A。不可用状态继续由现有引用解析器表达。

同 revision 的工作区通知不再清空选择；真实变化仍撤销旧浏览选择并重读来源。首次状态读取若晚于新通知返回，不能覆盖新状态。来源读取、普通删除和永久删除响应带当前请求身份校验；切到 B 后，A 的迟到响应不能关闭 B 面板。安全模式变化仍撤销旧操作界面。

T09 的可写入口处理同步动作。后台导入的目标句柄、任务归属、取消和切换期间不中断任务由 T10 接入；不能直接依赖旧 `activate` 的取消全部导入行为。

## 红灯和自动检查

原始日志见 [证据目录](evidence/spec78-t09/file-manifest.json)。目录属性保留证据原始字节；捕获日志作为 binary 保存，原有尾随空白不改写。测试通过公开核心接口、真实 SQLite 和真实图片文件检查外部结果，没有查询私表或增加测试专用存储入口。

| 场景 | 初次 RED | GREEN |
| --- | --- | --- |
| 未活动库写入 | `DeviceLibraries::write` 不存在 | 备注只改 B，current/lastOpened 仍为 A |
| 精确聚合来源 | target/read_source/write_source 不存在 | 标签、备注、分级、文件夹、删除独立；错误 contentId 拒绝 |
| 稳定引用 | source_reference 不存在；初实现误用只读句柄的 take_reference_lens，返回 SourceChanged | 改用核心内部独立 ReferenceLens，重新查找及断连后引用仍为 B |
| 正式来源整理 | 来源列表没有“整理此来源” | 实际控件发送 B 的完整身份 |
| 重复 monitor 通知 | 同 revision 事件取消已选 1 张 | App 公开行为检查保留选择，迟到初始状态不能回退事件 |
| 迟到普通删除 | A 响应关闭 B 面板 | 切来源后丢弃 A 的界面副作用 |
| 迟到永久删除 | A 永久删除响应关闭 B 面板 | 预览及确认响应均核对当前请求 |
| 同名资料库 | 列表仅显示名称与原图 ID | 唯一路径后缀与完整 title 均可核对 |

`t09-core-reference-green.log` 的原始名称保留；其内容实际上记录初次实现的失败。最后核心绿灯以 `t09-core-actions-final.log` 和 `t09-post-merge-core.log` 为准，不以文件名判断结果。

| 验证范围 | 实际结果 | 证据 |
| --- | --- | --- |
| 合 T04/T08 前完整 Rust 工作区 | 579 passed、0 failed、7 ignored | `t09-workspace-tests.log` |
| 合 T04/T08 后 source/device/workspace/folders | 25 passed、0 failed | `t09-post-merge-core.log` |
| 合并后严格 workspace all-targets clippy | 通过 | `t09-post-merge-clippy.log` |
| 合并后 cargo fmt --check | 通过，无输出 | `t09-post-merge-fmt.log` |
| 合并后完整前端 | 31 文件、249 项通过 | `t09-post-merge-frontend-rerun.log` |
| 合并后 TypeScript | 通过 | `t09-post-merge-typecheck.log` |
| 最后内部 ID 展示整理 | 4 文件、74 项通过；TypeScript 通过 | `t09-final-ui.log` / `t09-final-typecheck.log` |
| 独立正式资源构建 | debug/custom-protocol + Vite 通过 | `t09-native-build.log` |

7 个 ignored 沿用既有故障注入子进程入口和大型性能测试，未将其记为本单实测通过。完整 Rust 数量属于合并前检查，没有冒充合并后完整重跑。

首次合并后的全量前端有两项失败：新路径 title 断言误用未转义的 CSS 路径选择器，以及既有 TagIdentityPanel 保存对应检查超时。修正路径断言后，定向 8 项及全量 249 项通过。旧超时未修改产品绕过，原因未确认；保留首次失败和复核结果。

## 正式原生验证

环境为 Windows 11 专业版 `10.0.26300`，64 位，WebView/Edge `154.0.4258.62`。实测 WebView DPR `1.1041666269302368`，CSS viewport `1281 × 801`。这些是本次 WebView 观测，不等同实际系统 DPI 或多屏验收。

试件 identifier 为 `dev.kinshoko.spec78t09test`，driver 端口 4570/4571，应用数据和 WebView 目录隔离，`KINSHOKO_SKIP_AUTOSTART=1`。程序设置位于该 identifier 的独立 KnownFolder。构建只产生 debug 可执行文件，没有安装正式产品或公开发布。

实际 exe SHA256：`60345209555790f8abc078cb99fe2795f11f4bc2c0610f81cd0fac0282622d94`。通过产物保存在 ignored `work/e2e/t09-binary-36cab7e/kinshoko.exe`，真实资料库、钉图和组保存在 `work/e2e/source-actions-1791479547691`。根任务已逐文件校验归档四轮原件、exe、配置及实际设置；归档入口为 `work/v1-handoff/follow-up-spec/evidence/t09-native/root-preservation.json`。

[原生结果](evidence/spec78-t09/native-result.json) 记录产品来源、脚本来源/哈希、二进制哈希、环境、两个库及原图身份和 25 项断言。[构建清单](evidence/spec78-t09/t09-build-manifest.json) 与 [来源补充](evidence/spec78-t09/provenance-notes.json) 区分产品、脚本和后续界面修订。

实际步骤：

1. 用正式 IPC 建立两个同名库，分别导入同一 PNG，写入不同标签、备注和文件夹。当前保持 A，从正式聚合卡片选择 B，核对可见路径与 B 的详情。
2. 用正式控件修改 B 备注和分级，移出并重新加入 B 文件夹，添加 B 人工标签。逐项读取 A，确认整理不变；核对 current 始终为 A。调用实际来源候选命令检查 B 的本地身份。
3. 从 B 整理面板直接钉图并建立参考组。改变查询范围后核对引用仍为 B。关闭测试进程，将 B 根目录改名模拟断连，再启动正式程序，核对不可用状态、引用身份和拒绝的 B 读写；A 完整详情保持不变。
4. 恢复 B 路径并重启，核对 lastOpened 仍为 A、B 整理持久保存。删除 B 至回收站，预览并确认永久删除，核对实际 B 参考组影响、保留的缺失成员和仍存活的 A。错误字节身份及过期安全模式写入均明确拒绝。

已目视核对 [同名来源选择](evidence/spec78-t09/same-name-source-choices.png)、[B 独立整理](evidence/spec78-t09/explicit-inactive-source-after.png)、[来源使用控件](evidence/spec78-t09/source-pin-and-group.png)、[断连来源](evidence/spec78-t09/disconnected-source-keeps-reference.png) 和 [永久删除预览](evidence/spec78-t09/source-permanent-delete-preview.png)。这些原始截图属于 `36cab7e`，保留当时可见的内部 ID 行，不改图冒充最后界面。

前三轮停止于脚本问题，保留各自日志、结果和原始截图：第一轮 XPath 对组合文字使用 text() 全等；第二轮在文件夹选项尚未加载时设置值；第三轮在实际 revision 刷新时点击旧 WebDriver 元素。修正脚本等待真实可操作控件，并只重试明确未执行点击的 stale/no-such-element 后，第四轮 25 项通过。没有修改产品来回避这些脚本失败。第二轮旧结果的 source 字段当时取了脚本 HEAD；其真实二进制仍为 `36cab7e`，来源补充明确记录，原件未改写。

原生重启采用 WebDriver 会话关闭，并停止精确属于本单 exe 路径的测试进程；最后按本单 driver PID 清理。没有将强制测试重启称为托盘正常退出验收。[最终清理](evidence/spec78-t09/t09-native-cleanup.json) 确认 own app/driver/WebView 无残留，4570/4571 无监听，桌面已交还。

## 未验证

开发者主观体验、Windows 10、多显示器与实际系统 DPI、触笔和广色域硬件未验证。负责人已确认无 Windows 10 设备，保留该状态。debug 试件不代表 release 性能或颜色硬件验收。最后移除可见内部 ID 行的界面修订只补了受影响 UI/类型检查；最终组合界面由 T20 再看。T09 不替代 T20 全增量组合验收或 T21 真实公开签名自动更新。
