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

最小原生 RED→GREEN、脚本语法与增量 diff-check 通过。完整修正 smoke 正在等待 T11 固定构建后的实际运行，当前不计为通过；后续 CI 亦需实际完成。T10 新的保存位置确认接入后，完整 smoke 还需按正式入口同步并再执行。

两轮诊断只强制清理各自精确归档 exe，未操作用户程序。[清点](evidence/spec78-ci-smoke/desktop-release.json)确认 own app／WebView／driver 与端口均为空，桌面交还 T11。
