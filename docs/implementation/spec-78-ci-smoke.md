# #78 CI 冒烟接入回归

本记录属于独立增量 #78，不修改前置 #42／#71 或旧验收。应用 diagnosing-bugs 的实际反馈循环定位失败。

## 实际失败与最小复现

集成 `fad93218cc56ee31b77460e1b4ef0b1d8127ab3b` 的 [CI 37816370653](https://github.com/Yukk1No/kinshoko/actions/runs/37816370653) 在 `node e2e/smoke.mjs target/release/kinshoko.exe msedgedriver.exe` 建库后等待 `//h1[normalize-space()='冒烟测试库']` 超时。Rust、绑定、前端、Tauri 原生构建和安装包检查成功，后续还原度实验跳过。日志见 [原件](evidence/spec78-ci-smoke/fad-smoke-failed.log)。该轮没有上传失败页面，不能据此推断建库本身失败。

根代理使用 T05 已固定产品 `f7ef52b12681ed679927f7fef034629b923ae8ec`、exe SHA256 `7dca4915d39d648f5b0e7b615671d316b3e63b187ee97a44d4cbb2f8ed3ff239`，将反馈循环缩小为正式建库→等待当前选择→检查旧标题。此产品包含相同的工作区标题变更，但不是 CI 的 release 产物，不冒称在本机重跑了原 CI 二进制。运行环境 Windows 11、WebView2 154，独立 test identifier 与数据目录，端口 4478／4479。

命令 `node work/v1-handoff/follow-up-spec/ci-smoke-create-probe.mjs` 实际失败。公开 `current_library` 返回新建库及其身份，正式选择器也显示该库；页面标题为“资料库目录”，旧谓词为 false。[RED 原件](evidence/spec78-ci-smoke/create-red.json)及根 ignored 原始目录保留。

进一步核对三项预测：旧标题断言过时；库状态迟到；页面刷新迟到。第二轮只改为检查正式当前库选择，并额外等待 2500ms；新断言通过，旧标题谓词仍为 false。`node work/v1-handoff/follow-up-spec/ci-smoke-create-probe.mjs --corrected` 返回 0，证明标题已按工作区语义变化，不是增加等待时间可以恢复的库名标题。[GREEN 原件](evidence/spec78-ci-smoke/create-green.json)和[实际页面](evidence/spec78-ci-smoke/created-library.png)保留。

## 修正与验证范围

既有完整 smoke 改查当前资料库选择，重启后另核对同一资料库 ID；导入先展开正式“导入参考图”菜单。原有真实文件导入、失败项、缩略图比例与重开恢复断言保留。只结束精确测试 exe 的进程，避免按进程名影响别的 Kinshoko。强制测试重启不计为正常托盘退出。

脚本保存产品／脚本 SHA、实际结果，失败时保留 DOM 与截图。CI 上传这些报告，避免下次只得到超时文字。诊断脚本存证在证据目录，两个原始运行与真实数据留在 ignored 工作目录；不在产品加入诊断入口。

最小原生 RED→GREEN、脚本语法与增量 diff-check 通过。完整修正 smoke 随后在 T11 固定 debug 构建实际运行，5 项通过：建库、真实导入及逐项失败、原比例图片墙、相同资料库 ID 重启和图片墙恢复。[完整结果](evidence/spec78-ci-smoke/full-green-t11.json)绑定产品 `a99fd7683e5c00b896c99aaa49129ebfe2eefdf5`、exe SHA256 `6de689c8bb36e8fa0f1d7d037766d3d595ccbdb0a8e280c2177a80b9b495ed58` 与实际脚本 SHA256 `49fa759e3f6356c5600ef3efa3609cfc05cce080247bf60e4ca056e361dd4e23`。实际步骤使用 T11 的隔离 identifier、数据、profile 和 4568／4569；T11 负责精确进程清点后接续自己的原生流程。这个结果不是 CI release 产物的重测。

[CI 37820345166](https://github.com/Yukk1No/kinshoko/actions/runs/37820345166) 随后于 `2026-10-08T18:10:56Z` 完整成功。run head 为 `b3ac66896881d878833b1652c2a752a64bbdd754`；实际 PR 合成 checkout 为 `9e67b5ce1ef792beba2e21b2039164bfb283eda3`，parents 为固定基线 `536cc43` 与该 head。release exe SHA256 为 `f43ec10b9711e2066ca706b0e26d2891c476e50f0434a80e6b05d265f6e9ab58`。[CI 原始 smoke 结果](evidence/spec78-ci-smoke/ci-green-result.json)的 5 项断言全部通过；[完整步骤](evidence/spec78-ci-smoke/ci-green-run.json)包含原生安装包与安装检查。独立 downscale workflow `37820345148` 也成功。这些结果严格对应该轮源码，不扩大到之后的 T11 合入。

同轮非阻断还原度实验仍失败，34 个门槛样本中 11 个失败，见[原始 JSON](evidence/spec78-ci-smoke/ci-fidelity-report.json)与[原始报告](evidence/spec78-ci-smoke/ci-fidelity-report.md)。实际环境是 Windows Server 2022／Hyper-V Video／SwiftShader／WebView2 `131.0.2903.86`，不是本机 Windows 11／WebView2 154。CI 成功不表示颜色或公开质量验收通过；不同环境本身也不证明失败根因。旧报告和旧追踪保持原状。本轮完整下载及原始样本归档于根 ignored `work/v1-handoff/follow-up-spec/evidence/ci-37820345166/`。

T10 新的保存位置确认接入后，完整 smoke 还需按正式入口同步并再执行。

## T11 合入后的实际 CI

[CI 37823311722](https://github.com/Yukk1No/kinshoko/actions/runs/37823311722) 随后完整成功，head 为 `e9be4ea11fdd610270936e13e257e600d199d01f`，实际 PR 合成 checkout 为 `20a44ee3a7c4ae7d95d67b5ec231a8730e5b29ea`（parents `536cc43`／`e9be4ea`）。该轮 release exe SHA256 为 `4265979635b8cb2f834ab1246892e2b8f0fcc825d62602dd6fa708d298718943`，仍使用脚本 `49fa759e`，完整 smoke 5 项成功。见[原始结果](evidence/spec78-ci-smoke/t11-ci-green-result.json)及[实际步骤](evidence/spec78-ci-smoke/t11-ci-green-run.json)。同 head 的 downscale workflow `37823311786` 成功。

该轮 `fidelity-report-20261008-183322Z.json` 仍为 34 个门槛样本中 11 个失败，环境仍是 Server 2022／WebView2 `131.0.2903.86`。下载原件、样本与报告保留在 ignored `work/v1-handoff/follow-up-spec/evidence/ci-37823311722/`。没有覆盖较早失败，也没有把 CI 成功扩大为颜色、Windows 10、之后 T06／T10 或最终组合通过。

两轮诊断只强制清理各自精确归档 exe，未操作用户程序。[清点](evidence/spec78-ci-smoke/desktop-release.json)确认 own app／WebView／driver 与端口均为空，桌面交还 T11。
## T06 合入后的独立 CI 记录

后续 [CI 37826656513](https://github.com/Yukk1No/kinshoko/actions/runs/37826656513) 完整成功，head 为 `b190770fc3d004c6f4fa101af1ff29cf8871b28f`。实际 PR 合成 checkout 为 `ba18417470a74fe34c121a1c286db9535e3099ee`；GitHub commit API 核对 parents 为前置 `536cc43` 与该 head，tree 为 `19df69897f2b8642bd8825d4a46cdb13b27b8917`。[原始 run](evidence/spec78-ci-smoke/t06-ci-green-run.json)、[smoke](evidence/spec78-ci-smoke/t06-ci-green-result.json) 和 [来源记录](evidence/spec78-ci-smoke/t06-ci-origin-meta.json) 单独保留。

release exe SHA256 为 `877fcdc5a1aebfe1f0b08383691469ce88e1e4a3a1e3af0ea13bff2df76ede9d`。原 smoke 脚本 `49fa759e…` 在 18:59:31–18:59:46Z 完成 5 项。该来源包括 T06，不扩大为之后 T10／T12 或最终组合成功。

同轮非阻断颜色实验仍为 34 个门槛样本中 11 项失败，实际 Server 2022／Hyper-V／WebView2 131 环境保持。原始 `fidelity-report-20261008-185952Z.json`、样本与来源在 ignored `work/v1-handoff/follow-up-spec/evidence/ci-37826656513/`，43 文件／2456412 字节由逐文件 SHA 清单保存。CI 成功不代表颜色门槛成功。

## T10 保存目标接入后的实际 CI

[CI 37830066280](https://github.com/Yukk1No/kinshoko/actions/runs/37830066280) 完整成功，head `8fc3f522fb1243dd39e97b8927554efc17d10dab`。实际PR合成checkout `2d5d264e60d07b5221fe394e6492a72feeb13c41`，GitHub commit API验证parents为536cc43/8fc，tree `0c422841c29b878dbdba209d9e398bbd4753c552`。[实际步骤](evidence/spec78-ci-smoke/t10-ci-green-run.json)、[smoke原件](evidence/spec78-ci-smoke/t10-ci-green-result.json)、[来源](evidence/spec78-ci-smoke/t10-ci-origin-meta.json) 分别保留。

release exe SHA256为 `6999c1809069cc3a970eec3487045851c65591c0f32b561a46353661ff210af9`。脚本 `d9df46a1c82641e8677d9434dca9d631a43370a1037d6217b05e539141c7e01a` 使用正式目标选择与导入确认，在19:26:27–19:26:43Z完成5项。包含T10，不包含之后T12/T13/T17，也不是最终组合结果。downscale37830066214成功。

同轮 `fidelity-report-20261008-192650Z.json` 仍为34门槛样本中11项失败；CI成功未清除颜色门槛。原件、样本和来源独立保存于ignored `evidence/ci-37830066280/`，43文件/2455867字节。Installer artifact未下载或在本机执行，CI自己的安装检查不代替最终本机真实升级。

## T12 内容备份合入后的实际 CI

[CI37834445118](https://github.com/Yukk1No/kinshoko/actions/runs/37834445118) 完整成功，head `545bd5891f7aebece2fbfe806445d8323fbbe688`。实际PR合成checkout为 `eda6a0b6b8847aec107264518125df633f0c376a`，tree `870cda0403a325547c167b52db88fd51b1e8025c`；commit API核对parents为536cc43/545bd589。[实际步骤](evidence/spec78-ci-smoke/t12-ci-green-run.json)、[smoke原件](evidence/spec78-ci-smoke/t12-ci-green-result.json)和[来源](evidence/spec78-ci-smoke/t12-ci-origin-meta.json)分别保留。

release exe SHA256为 `32391d1ab839029d4b739bd587ca37b3ccb6a4cd16c0d3ce550b260d0da5e13e`。相同实际脚本 `d9df46a1...` 在20:00:58–20:01:17Z完成5项，正式导入包含目标确认。此来源包含T12，不包含之后T13/T17或最终组合。downscale37834444945成功。

同轮报告38样本、34门槛样本、11项失败。失败文件与上一轮相同，实际环境仍为Server2022/WebView131/SwiftShader。CI成功不清除颜色门槛。完整ignored原件与样本归档 `evidence/ci-37834445118/` 为43文件/2455848字节；没有下载或本机执行installer产物。
