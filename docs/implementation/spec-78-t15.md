# #78 T15 / #94 封印重复项预览

本单实现故事 41–43。起点为集成 `545bd5891f7aebece2fbfe806445d8323fbbe688`，在已释放的 `spec78-t01-frontend/kinshoko` 物理树创建 `codex/spec-78-t15`。没有继承前置 #42 / #71 的成功记录。负责人已经确认核心公开动作、真 SQLite/文件、正式程序和开发者真机验收边界；本单应用 TDD。

## 实现

复用 T10 `DeviceLibraries` 的固定目标任务及真实完成回执，不建立第二套导入 owner。普通 IPC 回执经 `Workspace::import_receipts` 使用与浏览相同的全部已知 provider 分级索引，包含查询范围之外和断连来源的已知 Adult。尚无分级继续可见。

默认只显示“有封印项重复，是否展开看看”。隐藏封印图身份、文件名和内容。当本次成功结果包含封印内容时，同一回执的全部成功类别一起收敛，避免用 imported/merged/refreshed/newVersion 与其他成功项做差得到封印子集数量。普通处理进度 done/total 和真实读取失败/重试路径保留；成功项明细、Eagle missing 数量不从保密回执返回。TaskFinished 事件使用无内容明细的传输回退；正式轮询返回检查后的回执。回收站只给通用提示，不自动恢复，也不进入预览。

明确点击后，后端从保存的真实 task/library 回执建立一次只读 capability。调用方只能提供 task identity；不能自报图片列表。预览 item 是后端生成的不透明身份，仅包含本次实际成功重复项中的 live 且全来源判为 Adult 的图。普通未知图、无关成人图、历史预览 item 和任意真实 image ID 均不能复用该 capability。

预览在专用只读 provider 中从真实原图读取一次不可变 buffer，验证 SHA 后调用既有 SDR renderer。原图、人工整理、数据库与派生缓存不写入；没有新增任何 mode 修改。解码不持 device/task 锁；结果在释放字节前再次检查会话、模式代次、回执归属、provider revision、live 状态与内容身份。关闭、失去 UI 上下文、回执撤销、下一次预览生成、切库/登记、来源移除、同模式代次更新及程序设置恢复都会使旧授权失效。程序设置恢复与 T13 的当前绑定保留逻辑共存。

前端 Dialog 的结构、showModal/cancel/close 与焦点生命周期直接适配固定认可原型 `prototype/reference-browser/src/components/Overlays.tsx::Dialog`。弹窗仅加载该回执返回的 opaque item，关闭撤销后端会话并撤销 Blob URL。明确同意按 task ID 保存，换回执不会短暂沿用上一张回执的同意。原型是体验来源，不是正式数据或原生验收。

## RED / GREEN

完整原始记录在本树 ignored `work/e2e/t15-*`；失败记录单独保留。

| 外部行为 | RED | GREEN |
| --- | --- | --- |
| 真多库 Adult/Unknown 同文件；浏览已隐藏而普通回执返回名称/ID/精确 merged | `t15-core-red.log` | `t15-projection-green-fixed.log` |
| 明确同意绑定实际完成跨库回执 | `t15-consent-red.log` | `t15-consent-green.log` |
| 解码结果等待释放时模式变化、切库 | `t15-transition-red.log`、`t15-library-context-red.log` | `t15-transition-green.log` |
| 磁盘原图被替换，旧回执/记录 SHA 不足以限定读取 | `t15-replaced-bytes-red.log` | `t15-replaced-bytes-green.log` |
| 默认正式导入栏提示与隐藏成功计数 | `t15-ui-red.log` | `t15-ui-green.log` |
| React 换回执时短暂将布尔同意传给下一任务 | `t15-consent-transfer-ui-red.log` | `t15-consent-transfer-ui-green.log` |

早期 `t15-projection-green.log` 包含 Python 默认编码异常并仍执行旧测试，不是 GREEN；原记录保留。`t15-core-boundaries.log` 是回收站提示补充 RED；之后在 `t15-core-boundaries-green.log` 已通过。自动审批曾拒绝一条尚未执行的拟议写入命令，理由是拟在专用 reader 调用 `set_safe_mode(false)` 读取预览。该命令没有执行。拒绝原文及未执行状态原样保存于 `t15-approval-rejection.txt`。最终使用上述完全不改变 mode 的只读 verified-buffer capability，安全替代已完成，无待批准的该动作。

`crates/kinshoko-core/tests/import_preview.rs` 现有 10 项公开动作检查：真实多库分级、未知目标副本、混合重复/新增/失败、Eagle refreshed、旧/外来回执与图 ID、关闭/解码后/下一回执/切库/模式撤销、断连已知 Adult、注销/换身份/真实原图替换、回收站/永久删除、普通 candidates/counts、原图 SHA/notes/tags 不变。没有私表断言或测试专用生产入口。

已执行的相关核心回归共 55 项成功、2 个真实故障子进程入口 ignored：import_preview 10、workspace 7、save_destination 9、safe_mode 18、eagle_deleted_content 11。日志 `t15-core-regression.log`。合入 T13 后严格 workspace clippy（all-targets，-D warnings）及 TypeScript 通过。完整前端 34 文件、273 项通过，见 `t15-merged-clippy.log`、`t15-merged-types.log`、`t15-merged-ui.log`。

## 原生验证与完成边界

原生隔离配置：`dev.kinshoko.spec78t15test` / `Kinshoko T15 Test`，driver 端口 4676/4677，跳过开机自启。正式运行前冻结 clean source/tree、逐文件 source/dist 清单、配置和 EXE SHA，根代理串行预约后才启动。样本由 `spec78_import_preview_fixture` 通过公开核心动作创建，均为可分发的合成 PNG。`e2e/sealed-import-preview.mjs` 使用真实正式命令与渲染控件；既有 picker 队列仅替代系统文件选择结果，不新增生产 bypass。

当前原生正式运行尚未执行；本节将在串行验收后记录实际结果。Windows 10 按负责人明确指示保留未验证，不再询问设备。自动 native 操作不代表主观人工认可；系统 DPI/多显示器、笔输入和色彩质量不由本单前端或合成图检查外推为通过。
