# #78 T20 — 最终组合验收

> 2026-10-26 补记：`e2e/spec78-combination*.mjs`、`e2e/spec78-combination-original-pixels.py`、`e2e/native-window-controls-t20.py`、`e2e/native-window-resize-t20.py`、`e2e/native-tray-exit-t20.py`（`spec78-combination-preflight.mjs` 与 `spec78-combination-fixture.mjs` 仍被 `native-standalone-guard.mjs` 使用，保留）随原生钉图（ADR 0013）取代 WebView 钉图层而退役（#305）。它们调用的 `pin_frame` 等命令已删，又只能配本文记录的冻结构建跑；需要时从提交 `3857dd8f` 取回（`git show 3857dd8f:e2e/<文件名>`）。

本单对应 #98、故事52。前几节按时间记录准备过程，其中“未执行”“尚未”只描述当时的状态。现状：两库组合原生轮次（r21–r23 与审阅修正后的新一轮）、原型对照、release NSIS 干净安装与升级都已执行，见后面各节；审阅修正一节另加了原生窗口控件。Windows 10、#99 签名自动更新、人工视觉验收、物理 DPI 与笔输入仍未验证。前置 #42／PR71、原始规格和既有验收状态保持原样。

## 分部

本记录按 `##` 节原样拆成以下几份（提交大小上限）：

- [1/4](spec-78-t20/part-1.md)：界面准备；已执行检查与保留失败；离线组合脚本准备；固定 ef77 审查后的脚本修正；尚未执行的构建与桌面门槛
- [2/4](spec-78-t20/part-2.md)：原图组合阶段的新增离线准备；最终验收的范围（已执行，见后文）；同一会话中的原型对照检查点；浏览器与 release NSIS 的离线准备候选
- [3/4](spec-78-t20/part-3.md)：最终组合运行（2026-10-09/10，本机 Win11）；界面改版合入后的复验（2026-10-10，本机 Win11）
- [4/4](spec-78-t20/part-4.md)：视觉修正与完整复验（2026-10-11，本机 Win11）；详情面板标签与备注改版（2026-10-11，本机 Win11）；release NSIS 干净安装与升级（2026-10-11，本机 Win11）
