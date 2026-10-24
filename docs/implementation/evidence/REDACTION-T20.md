# T20 脱敏补充记录

本记录补充[脱敏主记录](REDACTION.md)中明确排除的四份 T20 preparation/corrections JSON。原版本为 `c826269`，脱敏版本为 `4c9670f`；实际内容变换由 `2484ced` 完成。原文件中的个人目录改成 `<worktree>`、`%USERPROFILE%`、`%APPDATA%` 和 `%LOCALAPPDATA%` 等占位，并添加 `pathRedaction` 说明。原有验证结果与内部 SHA 引用保持原样。

以下 SHA256 直接由相应提交的 Git blob 字节计算。检出时发生的换行转换不参与散列。文件均位于 `docs/implementation/evidence/spec78-t20/`。

| 文件 | 原 SHA256（`c826269`） | 脱敏后 SHA256（`4c9670f`） |
| --- | --- | --- |
| `combination-browser-installer-preparation.json` | `1ec68668f925095ffd2c7163cbd8eeab769cce4a419cb22b012785936a1b2e59` | `98417756d0f8f64c5de345b2ca1489e1d221bb7ba3d3cc87709ff5d55685dc15` |
| `combination-corrections.json` | `92d73b58c15c236c6b90048857b64b028d140ded852afe33aa4c10c41b9d4e42` | `a4d42dc69ea3e54084d3d045f8af379168729be32f4cd31a2c31fa595d3e1a8f` |
| `combination-original-preparation.json` | `a89ca2d4d766301b0a470c2823e4a2985411906e3d49a9998bd883c91cd6eaf6` | `1b9305367c912d98c8e99f73dacf55b143f84f9bc23fc819db4039a603ea59e3` |
| `combination-preparation.json` | `59a8939c1289c36f8d8eb1bf39d2a638f243d9651b439551309b0d430306b13d` | `f03599a6065a015a1b01e22b9b09793b5b134490375fc38e1c49bb69b60b8c06` |

公开占位路径用于追溯，不能直接作为原生测试输入。执行测试时使用本地原始 manifest，继续核对冻结源码、可执行文件、配置和 driver 的真实路径及 SHA。

## 历史保留范围

按维护者选择，本次采用向前新增清理提交。没有改写历史或强推。未来版本的路径清理不会删除祖先提交中的原始字节。

2026-10-12 的固定范围核对以 `origin/codex/spec-78-integration` 的 `4ae8474` 为发布边界，检查 T20 基线 `c826269`、review-fix `4c9670f` 与 privacy-redact `afab275`：

- 主记录的 782 个清理前 blob 已全部存在于 `4ae8474` 的历史中，包括移出当前树的 48 张截图。它们是此前已公开的历史内容。
- 上表四份原始 T20 JSON 尚未在该公开历史中出现。原始字节合计 58,448，含 138 处个人目录前缀。它们会随 T20 历史首次公开，虽然当前版本已经脱敏。
- `d878399` 更新后的 `e2e/wall-capture.mjs` 也尚未公开。其原始 Git blob 为 `db33a26e12f249c2f8429f9f1e0ca223afa660e8`，SHA256 为 `ef412e21a3be06b39d53683778de6edd256b83af24adffba50c2bdf367e4b823`，含一处个人目录默认值。后续改为环境/profile 解析仍会保留这个历史版本。

因此本次新增历史包含五个首次公开的个人目录文本版本，共 139 处前缀。当前树的脱敏完成状态只适用于当前字节，不能表述为整条新增提交历史已经移除个人数据。被移出的截图原件和新原始运行材料继续保留本地，仅公开经过检查的派生证据。

四份测试脚本的当前默认值由环境、Cargo/profile 路径或本树工具目录解析。T18 运行脚本仍以显式位置参数优先，其后是 `KINSHOKO_TAURI_DRIVER` 和原始冻结 manifest；driver 的路径与 SHA 必须同时匹配。诊断隐私检查从实际用户名与 profile 目录名派生禁止内容，并使用中性检查标签，保留夹具名称、完整夹具/运行路径及通用用户目录前缀断言。
