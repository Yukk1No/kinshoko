# T13 独立证据索引

本目录属于 #78 / #92。`copy-index.json` 记录39份原始逐字节副本及其源路径、大小和 SHA256，没有重建脚本或改写原始结果。

- `independent-merge-result.json`、`independent-audit.json` 和 `independent-ui.txt` 对应独立合并 `152e652311b7c70425f707faece7253ea6f76872`，tree 与 worker `e53d78a` 相同。独立 UI45项成功。第一次 sandbox TEMP ENOENT 没有收集到测试；改为 workspace TEMP/TMP 后成功。
- `final-integration-*` 对应固定 `a8edbfbe`：11个公开核心 target、83个父测试、5个由父测试实际执行的 ignored 子进程入口；UI45项与 Tauri strict clippy。522个受检文件在 worker 前后逐字节不变。根 checkout 的34个文件仅换行不同，Git 内容相同。
- `checks.json` 的早期完整 workspace 来源为 `null`。659/10ignored 没有冻结源码清单，不能归给 b3 或5a。原始纠正前元数据仍在完整 ignored 归档，未覆盖原始测试日志。
- `native-result.json` 对应固定产品 `5a48939e`、exe `2c9e5a69eee742519ba08ec194662614f2da5b29cb5b68cad12149b14b2102df` 和实际 harness `99a7fd5`。47项断言包含48/48并发请求拒绝；不是95项断言。七份 `*-normal-quit.json` 为实际托盘退出码0；`actual-app-fault-exit.json` 的99单独记录。
- `configured-target-confirmation.png` 是替换前的确认。`restored-settings-live.png` 显示恢复后的 F9 和备份入口。`restored-viewer-background.png` 仅证明棋盘背景与选项，原图仍在加载。完整截图范围见 `screenshots.json`。
- 固定原生5a没有包含后来T12；a8是合入T12后的定向检查，不是最终全量或原生组合重跑。debug/skip自启保护下，系统自启登记仍未验证。

完整归档在根 ignored `work/v1-handoff/follow-up-spec/evidence/t13-native/`，238文件/127070176字节。包含冻结exe、全部失败轮、真实SQLite/原图、故障journal、回执、日志、清单及脚本。独立审查逐一核对全部归档大小和SHA256。KnownFolder配置和测试进程/端口已单独清点释放。WebView/local/roaming缓存与重复冻结目录不纳入归档。

Windows10、未执行硬件、旧颜色失败和真实公开签名更新保持独立状态。
