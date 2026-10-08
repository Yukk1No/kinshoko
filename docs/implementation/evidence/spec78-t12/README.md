# T12 独立证据

本目录只保存 #78 T12 / #91 的增量证据。#42、PR #71、T11 和前置备份记录没有改写。

验证状态：Windows 11 正式内容备份组合 57 项通过；同一冻结 exe 的 smoke 5 项通过。Windows 10 未验证。主说明见 [T12 交付文档](../../spec-78-t12.md)。

## 源码与检查

- [final-validation.json](final-validation.json)：最终产品 source/tree/exe SHA、实际脚本 SHA、538 源码输入与 10 项 dist 一致性、四轮状态、smoke 和释放记录。
- [checks.json](checks.json)：早期合入 T06 的实际检查，73 顶层套件、657 passed、11 ignored；保留历史。
- [checks-t10.json](checks-t10.json)：合入 T10 后实际 workspace 检查，74 顶层套件、669 passed、0 failed、11 ignored；前端当时为 266 项。
- `t12-feedback-final-*`：发布失败提示修复后的前端 34 文件、267 项、TypeScript、Vite 通过。Rust runtime 与上一完整 workspace 检查相同；后续 Rust/绑定变更只有文档。
- [original-log-copies.json](original-log-copies.json)：40 份本树 ignored `work/t12*.log` 的逐字节副本，记录来源、大小、SHA256。包含全部失败原件。

## 正式原生原件

[native-original-copies.json](native-original-copies.json) 共111条：107份直接原始副本，另4份历史 harness 从相应 Git LF blob 重建，字节匹配该轮记录的执行 SHA。重建脚本不冒称旧工作文件原件。smoke harness 则保存原始物理 CRLF 字节，并另核对与 Git LF 等价。数据库、原图和 exe 大文件由根任务另行归档；WebView缓存不纳入根归档，不把缓存排除解释为内容缺失。

最终冻结产品为 `00dfc611577361a679221dc8f06f99fdcedd466f`，exe SHA256 为 `8de4d9202cae6919a53757aa31ee8e2e4bc48f0cc013669a2414ed9ec42ecb3c`。实际通过脚本为 `846edf227d5b2c43692289dea06a11a97d38a17f`。两者产品输入无差异。构建对象内原先计划的 third-run 字段保留；每份结果的顶层 `harnessSource` / `harnessSha256` 才是该轮实际脚本。

| 原始运行目录 | 状态 | 范围 |
| --- | --- | --- |
| [3075331-first](native/runs/content-backup-t12-3075331-first/result.json) | failed | 控件仍 loading 时的即时反馈检查失败；原件保留。 |
| [3075331-second](native/runs/content-backup-t12-3075331-second/result.json) | failed | 等待后仍无匹配反馈；predicate 文案也有误。真实产品反馈缺陷另由公开渲染 RED 复现。 |
| [00dfc61-third](native/runs/content-backup-t12-00dfc61-third/result.json) | failed | 实际内容恢复已完成，invoke 包装观察失败；整轮没有改成成功。 |
| [00dfc61-fourth](native/runs/content-backup-t12-00dfc61-fourth/result.json) | passed，57 项 | 真实完成界面和公开事实回读；首库/首组发布中断、启动回退、完整重试。 |
| [同 exe smoke](native/smoke/result.json) | passed，5 项 | 正式建库、导入目标、原图比例、精确程序重启后保持。 |

恢复结果的 `freshReport` / `existingReport` 是实际渲染和公开事实组成的观察记录，不是截获或伪造的 `restore_backup` 返回。第四轮未替换 invoke。只读 SQLite 使用 `mode=ro` 与 `query_only=ON`。

组中断日志有独立字节原件和来源 SHA。首库中断日志只有结果内实际解析记录，不声称为字节原件。smoke 保存物理 CRLF 脚本；索引同时记录 Git LF 字节 SHA 与换行核对。

## 可见范围与环境

开发者已查看全部 7 张通过轮截图。[screenshots.md](native/screenshots.md) 限定每张截图的可见范围。02/03 不完整展示预览和成功反馈，对应结论由真实 DOM 与公开回读断言证明。后续 T20 补最终组合的可见截图。

KnownFolder 设置文件实际不存在。独立数据目录未被当作清空程序设置文件的证据。通过轮七个阶段的实际 `shell_settings`、KnownFolder exists/sha、WebView/视口和 invoke 属性均在原始结果内。此前进度消息误称文件存在，已按原始 `exists:false`、`sha:null` 更正。

[释放原件](native/t12-native-release.json) 记录自有进程与端口为空、KnownFolder 仍不存在。强制精确测试进程结束只证明重启恢复，不证明正常托盘 Quit。桌面已释放给 T13。

## 独立合入补记

独立 merger 在 `2db1c68bacaa781186a20f9c1f0f29f483770bc7` 核对119个提交证据文件与worker/index/commit一致，树与worker相同。107份原始副本和4份Git LF重建分别记录，根归档251文件/253143631字节全部复核。[独立结果](independent-merge-result.json) 固定的是该次合入快照；本补记随后只澄清证据范围，没有改原始结果、脚本或运行状态。

538项worker源码和10项dist在构建前/后/结束相同；root物理检出有29项源码仅换行不同，不声称root物理文件全部字节相同。初次启动前与第三轮前独立元数据观察KnownFolder为不存在；第四轮七阶段、smoke前置/释放记录为false/null。前三轮逐阶段结果只有shellSettings，不推断不存在的逐阶段文件观察。

独立检查fmt、TypeScript、脚本、whitespace和4个公开前端套件73项成功。没有重新运行原生或扩大完整Rust的实际来源。
