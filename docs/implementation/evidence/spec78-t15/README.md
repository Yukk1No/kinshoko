# T15 原始检查与独立合并证据

本目录只记录 #78 / T15 / #94。本目录不修改或继承前置 #42 / #71 的完成状态。

`copied-files.json` 记录 165 份原始文件的来源、字节数和 SHA256，共 6,817,379 字节。文件按原字节复制，`.gitattributes` 沿用其他增量证据目录的原始字节约定。完整固定 EXE、真实 SQLite 和合成原图保留在根工作区 ignored 归档，没有加入本目录。

- `worker-raw/`：87 份原始检查、RED/GREEN、固定清单和未执行提案的记录。
- `native-v1/`：原始 `passed36` 保持原状；首块后撤销的新要求实际为 RED，没有扩大为最终成功。
- `native-v3-first/`：原始 `failed23` 保持原状；harness 返回值缺少元数据，完整场景未完成。
- `native-final/`：同一 v3 固定产品、fresh fixture、纯 harness 返回元数据修正后的 `passed43`。源为 `473bdb1`，EXE SHA256 为 `7e083e5c0c44375dae6d17691e495bffab5f4941e74792e5730c8d97dcd39e0e`；harness 来源为 `364cdac`。不是交付提交重新构建的包。
- `merger/`：独立审查、实际命令与完整结果。原合并 `d93e7f8` 的 tree 与 worker 相同；纯文档和真实绑定重生成后续为 `2d6bb1a`。原始 `diff-whitespace.txt` 失败和修正后日志同时保留。

v2 固定包没有执行原生检查。原始提案中的 mode 修改没有执行；最终只读 capability 不改变全局安全模式。

自动原生检查不代替主观人工认可。Windows 10 按负责人指示保留未验证。多显示器、物理系统 DPI、笔输入与色彩质量没有由本目录合成图结果外推。清理为精确强制清理，不计正常托盘退出。最终组合验收属于 #98。
