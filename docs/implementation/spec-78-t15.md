# #78 T15 / #94 封印重复项预览

本单实现故事 41–43。起点为集成 `545bd5891f7aebece2fbfe806445d8323fbbe688`，在已释放的 `spec78-t01-frontend/kinshoko` 物理树创建 `codex/spec-78-t15`。没有继承前置 #42 / #71 的成功记录。负责人已经确认核心公开动作、真 SQLite/文件、正式程序和开发者真机验收边界；本单应用 TDD。

## 实现

复用 T10 `DeviceLibraries` 的固定目标任务及真实完成回执，不建立第二套导入 owner。普通 IPC 回执经 `Workspace::import_receipts` 使用与浏览相同的全部已知 provider 分级索引，包含查询范围之外和断连来源的已知 Adult。尚无分级继续可见。

默认只显示“有封印项重复，是否展开看看”。隐藏封印图身份、文件名和内容。当本次成功结果包含封印内容时，同一回执的全部成功类别一起收敛，避免用 imported/merged/refreshed/newVersion 与其他成功项做差得到封印子集数量。进行中的正常处理进度与真实读取失败/重试路径保留；保密完成回执的 done/total 同样收敛，避免与失败数做差反推封印成功数量；成功项明细、Eagle missing 数量不从保密回执返回。TaskFinished 事件使用无内容明细的传输回退；正式轮询返回检查后的回执。回收站只给通用提示，不自动恢复，也不进入预览。

明确点击后，后端从保存的真实 task/library 回执建立一次只读 capability。调用方只能提供 task identity；不能自报图片列表。预览 item 是后端生成的不透明身份，仅包含本次实际成功重复项中的 live 且全来源判为 Adult 的图。普通未知图、无关成人图、历史预览 item 和任意真实 image ID 均不能复用该 capability。

预览在专用只读 provider 中从真实原图读取一次不可变 buffer，验证 SHA 后调用既有 SDR renderer。原图、人工整理、数据库与派生缓存不写入；没有新增任何 mode 修改。解码不持 device/task 锁；结果在释放字节前再次检查会话、模式代次、回执归属、provider revision、live 状态与内容身份。关闭、失去 UI 上下文、回执撤销、下一次预览生成、切库/登记、来源移除、同模式代次更新及程序设置恢复都会使旧授权失效。程序设置恢复与 T13 的当前绑定保留逻辑共存。

最终发送复用 T17 的 `with_visibility_commit` 公共壳内许可，和安全模式设置、T13 设置恢复使用同一撤销边界。锁序为 transition（如需）→许可→device/catalog/workspace/Shell→desktop；读取与解码先释放资源锁。会话 close/dismiss、provider context 变更也在许可内提交。主窗口销毁只立即增加代次，再派发工作线程完成许可内撤销，避免主线程等待原生同步调用。

字节通过当前 receipt 的 Channel 发送，普通命令只返回确认。这里依据本机锁定的 `tauri 2.12.1/src/ipc/channel.rs`（SHA256 `9d20fad897f8377484c7bd7f63b030653501a08b36f03def9cc5123c2a98623e`）实际实现：raw 长度严格小于 1024 时直接发送 callback，长度达到 1024 时存入通用 fetch 队列。本单固定每块最多 1023 字节，每块分别在短许可和会话锁内核对同一授权及只读 provider revision，然后同步发布该块；块间释放许可和所有资源锁，结束标记也单独核对，避免关闭后的通用 fetch 留存内容。已经核验的 buffer 和 guard 对调用方保持只读，guard 仍指向 T10 同一个真实会话；每块检查该会话仍为当前授权，provider revision 改变同样撤销。前端同时等待结束标记和命令确认，撤销或错误时丢弃片段；关闭后的迟到片段不会创建 Blob。

前端 Dialog 的结构、showModal/cancel/close 与焦点生命周期直接适配固定认可原型 `prototype/reference-browser/src/components/Overlays.tsx::Dialog`。弹窗仅加载该回执返回的 opaque item，关闭撤销后端会话并撤销 Blob URL。明确同意同时绑定 task ID 与当前界面资料库上下文，换回执或换当前资料库不会短暂沿用旧同意。当前资料库变化立即卸载预览、撤销 Blob 与后端会话；T10 原任务回执及固定保存位置仍保留，返回原库也需再次明确展开。原型是体验来源，不是正式数据或原生验收。模式或工作区事件立即收敛旧回执成功统计，并增加界面代次，拒绝旧轮询的迟到响应。

## RED / GREEN

完整原始记录在本树 ignored `work/e2e/t15-*`；失败记录单独保留。

| 外部行为 | RED | GREEN |
| --- | --- | --- |
| 真多库 Adult/Unknown 同文件；浏览已隐藏而普通回执返回名称/ID/精确 merged | `t15-core-red.log` | `t15-projection-green-fixed.log` |
| 明确同意绑定实际完成跨库回执 | `t15-consent-red.log` | `t15-consent-green.log` |
| 解码结果等待释放时模式变化、切库 | `t15-transition-red.log`、`t15-library-context-red.log` | `t15-transition-green.log` |
| 磁盘原图被替换，旧回执/记录 SHA 不足以限定读取 | `t15-replaced-bytes-red.log` | `t15-replaced-bytes-green.log` |
| 默认正式导入栏提示与隐藏成功计数 | `t15-ui-red.log` | `t15-ui-green.log` |
| 完成进度减去失败项可算出封印成功数量 | `t15-completed-progress-red.log` | `t15-completed-progress-green.log` |
| UI 模式/工作区变化后仍显示成功统计及接受旧快照 | `t15-menu-context-red.log` | `t15-menu-context-green.log` |
| 预览字节不能通过普通命令确认体返回 | `t15-preview-channel-red.log` | `t15-preview-channel-green.log` |
| 首块发布后 close 必须拒绝真实原图剩余块 | `t15-transmission-core-red.log` | `t15-transmission-core-green.log` |
| 大图发送中撤销，不能等全图完成 | `t15-transmission-native-trace-red.log`（重判真实 v1 原件） | 待新固定包原生复验 |
| 当前资料库变化后仍显示旧回执图片 | `t15-current-library-ui-red.log` | `t15-current-library-ui-green.log`（含迟到读取不复活） |
| React 换回执时短暂将布尔同意传给下一任务 | `t15-consent-transfer-ui-red.log` | `t15-consent-transfer-ui-green.log` |

早期 `t15-projection-green.log` 包含 Python 默认编码异常并仍执行旧测试，不是 GREEN；原记录保留。`t15-core-boundaries.log` 是回收站提示补充 RED；之后在 `t15-core-boundaries-green.log` 已通过。自动审批曾拒绝一条尚未执行的拟议写入命令，理由是拟在专用 reader 调用 `set_safe_mode(false)` 读取预览。该命令没有执行。拒绝原文及未执行状态原样保存于 `t15-approval-rejection.txt`。最终使用上述完全不改变 mode 的只读 verified-buffer capability，安全替代已完成，无待批准的该动作。

`crates/kinshoko-core/tests/import_preview.rs` 现有 13 项公开动作检查：真实多库分级、未知目标副本、混合重复/新增/失败、Eagle refreshed、旧/外来回执与图 ID、关闭/解码后/下一回执/切库/模式撤销、断连已知 Adult、注销/换身份/真实原图替换、回收站/永久删除、普通 candidates/counts、原图 SHA/notes/tags 不变。没有私表断言或测试专用生产入口。

已执行的相关核心回归共 55 项成功、2 个真实故障子进程入口 ignored：import_preview 10、workspace 7、save_destination 9、safe_mode 18、eagle_deleted_content 11。日志 `t15-core-regression.log`。合入 T13 后严格 workspace clippy（all-targets，-D warnings）及 TypeScript 通过。该阶段完整前端 34 文件、273 项通过，见 `t15-merged-clippy.log`、`t15-merged-types.log`、`t15-merged-ui.log`。

Channel 变更后严格 clippy 与 TypeScript 通过（`t15-channel-clippy-fixed.log`、`t15-channel-types.log`）；初次 clippy 的闭包类型推断失败单独留在 `t15-channel-clippy.log`。完整前端首次复验 276/277 成功，既有 `SharedApprox.test.tsx` 的迟到 unsafe 列表用例失败，原日志 `t15-channel-ui.log`；单独复验该文件 5/5 成功，`t15-shared-approx-rerun.log`，尚未将该次完整复验记录成通过。随后第二次完整复验 36 文件、277 项成功（`t15-channel-ui-rerun.log`），保留首次失败，不将两次结果合并。

完成进度公开动作补充 RED/GREEN 后，v1 预冻结阶段 T15 核心 11 项、T13 核心 7 项（含真实恢复故障子进程）、strict workspace clippy 与 TypeScript 成功。合入独立共享许可小提交 `23b53db6030000f2389cabede22f8f401bf92ec4` 和 SettingsPanel key 小提交 `00ded51640fec5a8bbc26fd6d0f25691be06636b` 后，完整前端 36 文件、277 项成功且无重复 key 警告。最终预冻结日志为 `t15-final-core.log`、`t15-final-clippy.log`、`t15-final-types.log`、`t15-final-ui.log`。

## 原生验证与完成边界

原生隔离配置：`dev.kinshoko.spec78t15test` / `Kinshoko T15 Test`，driver 端口 4676/4677，跳过开机自启。正式运行前冻结 clean source/tree、逐文件 source/dist 清单、配置和 EXE SHA，根代理串行预约后才启动。每次运行保留主 harness 与 `scripts/check-sealed-preview-revocation.mjs` 依赖的实际源码、字节数和 SHA256。样本由 `spec78_import_preview_fixture` 通过公开核心动作创建，均为可分发的合成 PNG。`e2e/sealed-import-preview.mjs` 使用真实正式命令与渲染控件；既有 picker 队列仅替代系统文件选择结果，不新增生产 bypass。

首次原生 v1 在 Windows 11 专业版 build 26300、Edge/WebView 154、实际 DPR 1.1041666、1281×801 上运行，时间 2026-10-08 20:34:44.950–20:35:14.969 UTC。固定 source `92edcf64cca735a6d3bc66f459f7b933390c3f1a` / tree `b91c9fff37776104fd07572436b5eb72e2086d03`，EXE SHA `2c09a63113a9a2e5ea0ea3c772173f3c3403cf05a6ec00fa69eaa6d53673f90b`，555 source+10 dist 清单 `t15-build-source.json`。原始 `t15-native-run-v1/result.json` 按当时断言为 passed 36，原件不改。三张截图已经实际查看：默认提示无封印名称/计数/图片，明确展开仅本次一张合成噪声图，关闭后重新遮蔽。全局 safe mode 六次实测均 true，同模式程序设置恢复、外来 ID、旧 item、普通 candidates/counts、备注/标签/初始四个库内原图 SHA 均通过。

v1 **不是最终完成证据**。首块到达后 close 和同模式 on 更新都等完整 12,962,853 字节 / 12,672 块传完才返回，分别约 2097ms / 1914ms。旧实现把整个发送循环放在共同许可内，导致发送中不能真正撤销。根审核要求新增“首块后撤销应终止剩余内容并拒绝完成”的期望。`scripts/check-sealed-preview-revocation.mjs` 对 v1 真实原件重判，两项均 RED（日志 `t15-transmission-native-trace-red.log`）；这不是再次启动旧包。公开核心动作也先真实复现首字节后 close 仍发布剩余 PNG 的 RED，随后改为上述逐块短提交。当前已补核心 GREEN：13 项通过，并覆盖第一字节后的 close、新同意、换库、模式代次和源图编辑，连迟到空结束标记也拒绝。受影响核心回归 65 项通过（另有真实故障子进程入口 ignored），`t15-stream-regression.log`；strict workspace clippy 通过，`t15-stream-clippy.log`。待新固定包原生复验。

v1 在 20:36:33 UTC 完成精确 cleanup：own EXE/profile/WebView/driver 与 4676/77 均空。KnownFolder 原无→实际记录 `safeMode:true`、SHA `7ab1eb0d453365c6f8c4b1de3a6c10bac9185790bf3b49e047f5e64b0391c2dd`→复制本次设置证据后仅将独立目录恢复为不存在。`cleanup.json` 明记这是 WebDriver session DELETE 与精确 own EXE/driver 强制清理，不是正常 tray Quit。Windows 10 按负责人明确指示保留未验证，不再询问设备。自动 native 操作不代表主观人工认可；系统 DPI/多显示器、笔输入和色彩质量不由本单前端或合成图检查外推为通过。

预备 v2 包 source `4a919563a1f9eb0b96515019c8a534e1e0b7826b` 已冻结但没有执行 native：排队期间公开界面测试发现当前资料库变化后已显示预览仍留存，RED 原件保留；预约随后撤销。修复同意的当前上下文边界后重新冻结，v2 包与清单保留为未执行记录，不代替新固定包的原生结果。

当前资料库界面修复后受影响 12 项界面检查、TypeScript 与完整前端 36 文件 / 279 项通过，日志 `t15-current-library-ui-green.log`、`t15-current-library-types.log`、`t15-current-library-all-ui.log`。该修复只限定预览同意的界面上下文；没有变更 T10 任务归属或核心权限。
