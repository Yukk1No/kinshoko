# #78 T18 / #96 Windows 运行时能力

本单实现故事 51。起点为 `152e652311b7c70425f707faece7253ea6f76872`。分支为 `codex/spec-78-t18`。本单不继承 #42／#71 的通过状态。

## 行为与范围

正式主窗口、设置和钉图共用能力提示与本机诊断入口。界面沿用已认可原型的正式侧栏和设置结构；原型只作体验参考。新增检查使用内置 1×1 PNG、生产钉图 renderer 和白色像素读回。检查不读取用户原图，不持久保存能力日志，不上传。

必要能力来自现有生产路径：`HTMLImageElement.decode` 负责钉图源图解码，二维画布负责钉图绘制。缺少接口、实际样本失败与解码超时有各自原因。无法建立画布时，钉图仍执行 `pin_ready`，显示错误与恢复入口，避免窗口一直隐藏。

float16 是可选后备存储。运行时拒绝 float16 或新的 context 选项时，renderer 使用 8 位或默认二维画布。`createImageBitmap` 与 display-p3 不作为普通浏览的必要条件。界面和报告都明确：基础操作完成、`colorSpace` 或 `colorType` 声明不能证明色彩还原度通过。

更新按钮只打开固定的[微软 WebView2 下载页](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。页面提供 Evergreen 引导与独立安装程序。程序提示更新后从托盘退出并重新启动。微软说明[已启动的应用需要重新启动才能使用更新后的 Runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/developer-guide)。本单没有下载、安装、退出或自动更新动作。

诊断沿用公开核心 `report_with_runtime`、已有脱敏规则、正式保存对话框和使用者主动操作。新增输入只接受固定能力状态，不接收路径、图片或任意浏览器错误文字。报告区分“本窗口未检查”和实际完成的基础操作。没有新 unsafe，也没有生产测试专用 IPC 或环境覆盖。

最低支持范围按本窗口实际完成的操作说明，不写未经实测的数值版本下限。微软建议[功能检测与平滑回退](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/versioning)；这是实现依据，不是 Kinshoko 的兼容性证明。Windows 10／11 是目标范围。负责人没有 Windows 10 设备或 VM，已接受其未验证状态。

## TDD 与本单检查

原始记录在本物理树 ignored `work/t18/`。下表初始检查属于未冻结的本单工作区，不能归给后续提交。

| 行为 | 有效 RED | GREEN |
| --- | --- | --- |
| float16 选项抛错后仍可 8 位绘制 | `renderer-fallback-red.txt` | `renderer-fallback-green.txt`，renderer 10/10 |
| context 新字典被拒绝后仍使用默认二维画布 | `renderer-default-red.txt` | `renderer-default-green.txt`，3 文件 13/13 |
| 未测能力不能从 OS／WebView 版本推断 | `runtime-unknown-red.txt` | `runtime-unknown-green.txt`，核心诊断 7/7 |
| 缺少必要画布的报告含真实原因 | `runtime-report-red.txt` 为公开 API 尚缺失的编译 RED | `runtime-report-green.txt`，核心诊断 8/8 |
| 必要能力失败的界面、更新入口与本机诊断 | `runtime-ui-red.txt` 为组件尚缺失的 RED | `runtime-ui-green.txt`，定向 26/26 |
| 缺少画布的钉图显示错误并提交 ready | `pin-runtime-red-clean.txt` | `pin-runtime-green.txt`，5 文件 28/28 |
| 设置遮罩内保留失败原因与恢复动作 | `settings-recovery-red.txt` | `settings-recovery-green.txt`，4 文件 29/29 |

`pin-runtime-red.txt` 缺少 Tauri 窗口夹具，不能算产品 RED。`pin-runtime-red-behavior.txt` 同时有清理错误；修正夹具后另存真实行为 RED，没有覆盖原件。绑定由 ts-rs 生成，`bindings.txt` 192 个导出通过。

工作区 TypeScript 与 strict clippy（core + Tauri all-targets，jobs=2）已执行，原件为 `typecheck.txt` 和 `clippy.txt`。前端完整一轮 `ui-full.txt` 为 272/273，失败是 `TagOrganize.test.tsx:472`。独立文件 `tag-organize-isolated.txt` 为 11/11。原因仍未确认；可能涉及延迟词表通知清除刚打开的 picker。没有改测试等待来隐藏候选体验问题。最小顺序和代码位置保留在 `work/t18/tag-organize-observation.md`，供最终组合复核。

## 原生证据边界

正式原生验证使用独立 identifier `dev.kinshoko.spec78t18test`、端口 4618／4619、自有应用数据与 WebView profile、`KINSHOKO_SKIP_AUTOSTART=1`。构建前后必须 clean，source／dist／EXE／driver／配置哈希保存于 `work/t18/native-source.json`。KnownFolder 的真实 settings 路径单独记录，不以 APPDATA 覆盖代替证明。此节后续填写实际 run 和截图来源；当前不能据此宣称原生通过。

受控 JS 缺失只代表当前 Runtime 中被控制的接口缺失。它不能代替真实旧 Runtime、完全未安装 Runtime 或 Windows 10。代表性原图和钉图显示也不能代替颜色、ICC、HDR 或缩放量化门槛。

## 历史状态与未验证项

历史 CI `37834445118`（head `545bd589`，实际 checkout `eda6a0b6b8847aec107264518125df633f0c376a`，tree `870cda0403a325547c167b52db88fd51b1e8025c`）在 Server 2022／WebView 131／SwiftShader 上颜色门槛失败 11/34，smoke 5 项成功。根任务保存完整原件 `evidence/ci-37834445118/`，另见 `spec-78-ci-smoke.md`。该环境差异没有证明失败原因；更新提示不能豁免软件缺陷。历史结果不属于本单源码。

Windows 10、真实较旧／缺失 Runtime、数值最低支持版本及最终硬件颜色门槛未验证。仓库实际公开但没有 Releases；应用仍处于手动更新阶段，生产公钥为空。本单没有更改可见性、Release、生产签名或自动更新开关。
