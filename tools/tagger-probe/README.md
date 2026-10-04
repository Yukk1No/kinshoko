# Kinshoko 打标探测

测试自动打标模型在这台电脑上的速度和结果，生成一份报告发给开发者。对应 [#6](https://github.com/Yukk1No/kinshoko/issues/6)。

## 使用

1. 解压整个文件夹，保持 `kinshoko-tagger-probe.exe` 和 `DirectML.dll` 在一起。
2. 双击 `kinshoko-tagger-probe.exe`，按提示回车开始。
3. 第一次运行会下载约 1.7 GB 模型和约 0.8 GB 公开样本图，之后不再下载。打标可能需要几十分钟，期间可以打开优动漫随便画几笔。
4. 结束后桌面会出现 `kinshoko-probe-<数字>.zip`，把它发给开发者。

报告只包含硬件型号、耗时和公开样本的打标结果，不读取你自己的图片或文件。模型、样本和历史记录保存在 `%LOCALAPPDATA%\Kinshoko\probe`，不需要时可以整个删除。

## 它测什么

- PixAI Tagger v0.9（DeepGHS ONNX）与 WD SwinV2 v3，分别在 DirectML（显卡）和 CPU 上运行。
- 加载时间、首张耗时、解码／预处理／推理的 p50 与 p95、总耗时、峰值内存与显存。
- DirectML 运行时各节点实际落在哪个执行器，用于发现静默回落 CPU。
- 同一张图在 CPU 与 DirectML 上的分数差和阈值后标签集合是否一致；WD 另比较分级。
- 每张样本的打标结果（`predictions.jsonl`），供开发者对照 pixiv 作者标签和 R-18 标记。

PixAI v0.9 只输出一般与角色标签，没有内容分级；分级由 WD 提供，最终来源待结果决定。

## 开发

需要 Rust 与 MSVC Build Tools。

```bash
cargo run --release -- --samples-dir ../../samples/pixiv --samples-dir ../../samples/pixiv-r18 --no-prompt
```

开发模式从本地目录按清单查找并校验样本，也会用上 R-18 清单。其他参数：`--limit <n>`、`--skip-cpu`、`--skip-gpu`、`--data-dir <dir>`。发给目标机器的版本由 GitHub Actions 的 `tagger-probe` 工作流在 Windows 上构建并上传为 artifact。
