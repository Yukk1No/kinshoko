# #78 T17 / #95 瀑布流原图框选

> 2026-10-26 补记：`e2e/wall-capture.mjs`、`e2e/native-wall-observe.py`、`e2e/native-wall-pixels.py`、`e2e/native-wall-pixels.test.py`、`e2e/native-clipboard-observe.py`、`e2e/build-wall-occluder.ps1`、`e2e/native-wall-occluder.cs`随原生钉图（ADR 0013）取代 WebView 钉图层而退役（#305）。它们调用的 `pin_frame` 等命令已删，又只能配本文记录的冻结构建跑；需要时从提交 `3857dd8f` 取回（`git show 3857dd8f:e2e/<文件名>`）。

本次是独立增量。没有改写前置 #42 / PR #71，没有继承其完成状态。
当前状态：产品 `205f953` 的完整 Wall 原生验收在一轮连续运行中通过（170 项）。100%／150% 系统缩放、Windows 10 和笔输入仍未验证。

## 分部

本记录按 `##` 节原样拆成以下几份（提交大小上限）：

- [1/2](spec-78-t17/part-1.md)：结果与来源；冻结因果边界；准备与最终提交；共享发布锁与撤销；已保留的证据；尚未验证；最终构建前固定检查（2da427e）；新 c443 构建前两轮原生记录
- [2/2](spec-78-t17/part-2.md)：原图准备不持贴图权限锁；历史锁不跨越编码与完整导入；历史接缝修正后的完整检查（20e39e3）；205f953 完整 Wall 原生验收
