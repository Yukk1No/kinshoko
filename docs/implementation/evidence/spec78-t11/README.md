# T11 独立验收原件

本目录仅记录 #78 / #90 的增量实现。没有继承 #42、PR #71 或其他工单的完成状态。

- [实现与验证记录](../../spec-78-t11.md)：边界、提交、环境及未验证项。
- [构建来源](build-source.json)：原生产品 a99fd768、tree、exe SHA、独立配置及驱动 SHA。
- [验收后源码/dist 清单](source-dist-after-native.json)：实际采集时间、逐文件哈希及产品 Git blobs 比较。不是构建前采集。
- [组合检查明细](checks.json)：633 Rust 顶层测试、255 前端测试；真实原件在 `logs/`。
- [通过轮结果](native-passed/result.json)：26 项、隔离数据目录、实际 DPR/viewport、来源 ID 与成员布局。该目录另有 8 张实际截图、生成的 PNG 夹具及原始导出包。
- [首轮失败结果](native-first-failed/result.json)：控件就绪等待超时；HTML、截图及原始日志保留。修复脚本等待后，同一个产品二进制通过。
- [完整 smoke](ci-smoke-result.json)：根最终修正脚本实际运行，5 项通过。
- [原生释放记录](native-release.json)、[smoke 释放记录](ci-smoke-release.json)：本任务进程与预约端口清空。
- [逐字节复制清单](copies.json)：每份原件的绝对来源、相对副本、字节数与 SHA256。副本逐项校验后写入本目录。ignored 原件仍保留。

`portable-tags.mjs` 是通过轮脚本的逐字节副本。其 Git 来源是 a07e073。实际产品来自 a99fd768，脚本提交只补控件等待。文件选择器使用既有测试队列；其余流程执行正式页面动作与真实原生后端。

`logs/t11-red-*` 是公开行为的先失败记录。对应 `t11-green-*` 为实现后的通过记录。`t11-hidden-dependency-test-compile-error.txt` 是测试编写时的编译错误。`t11-green-shared-content-adapter.txt` 保留误填目标名的命令错误；实际通过在同前缀的 `-correct-target.txt`。历史 `t11-core-all.txt` 保留 Eagle 旧格式夹具缺少新增迁移回退的失败；修复夹具后完整结果以 `t11-t05-combined-workspace.txt` 为准。

Windows 10 未验证。规模性能、发行签名、正常托盘退出及 T10 任务归属均不由本目录宣称通过。