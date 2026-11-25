# 4. 在目标硬件上的可行性

[← 返回索引](../local-embedding-search.md)

**显存与内存（来源陈述＋推论）。** PixAI v1.0 FP16 分块版在 RX 6500 XT 4 GB 上峰值约 1.6 GB，约 2.75 秒一张；没有独显时，FP32 在 CPU 上约 29 秒一张、约 4.6 GB 内存（[验收约定](../../validation/acceptance.md)）。EmbeddingGemma 2 的 ONNX 文字图加视觉图，在 fp32 下文件合计约 1.75 GB，q8 约 0.51 GB（见[EmbeddingGemma 2 事实核查](embeddinggemma-2.md)）；文件大小不等于显存需求，[标签模型调研](../tagger-model-comparison.md)已经说明过这一点。两个模型能否同时放进 4 GB 显存，**未实测**。保守做法是在同一个子进程里先后加载：打完一批标签、卸载打标模型，再生成向量。

**单张成本（作者自报）。** DigUp 在 M4 Pro（Metal、Q8_0、140 软 token）上约 0.12 秒一张图；在 2017 年 Core i5 上只用 CPU 约 5 秒。[ModelSpeed.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/digup/ModelSpeed.swift)、[README](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/README.md)。DirectML 和 RX 6500 XT 上的数字未知。q8 的 `MatMulNBits`／动态量化算子在 DirectML 上是否会回落到 CPU，**未核实**。

**子进程（适配推论）。** 建索引放进 ADR-0004 的打标子进程最自然：同样隔离崩溃，“画师绘画时暂停或结束子进程”的策略也一起覆盖。查询时的文字编码是另一回事。约 270M 参数的文字部分，每次查询都要算一次，作为排序输入，延迟必须在“交互响应约 100 ms”的预算内（[验收约定](../../validation/acceptance.md#交互响应)）。可以借 DigUp 的做法，增加一个常驻的查询子进程；也可以在主进程里只用 CPU 跑文字图。后者改变了 ADR-0004 “推理不进主进程”的前提，需要另行决定。PixAI 特征方案只做以图搜图，不需要查询时推理，这个问题也就不存在。

**索引（来源陈述＋推论）。** DigUp 实测 7 万个 768 维 float16 向量占 108 MB，暴力查询多出的时间在毫秒级（见[DigUp 设计参照](digup.md)）。按同样的比例推算，20 万张图在 768 维时约 0.3 GB，截短到 256 维约 0.1 GB；用 PixAI 的 1024 维特征约 0.4 GB。这些是算术估计，不是实测。Rust 侧有三种可选做法：

| 方式 | 来源陈述 | 适配 |
|---|---|---|
| SQLite BLOB＋Rust 暴力计算 | DigUp 的做法（见[DigUp 设计参照](digup.md)） | 过滤集合由 Library 计算，最直接；20 万张时可以把 float16 矩阵放进内存，或分块读取 |
| `sqlite-vec` 的 `vec0` | 元数据列可以写进 KNN 查询的 `WHERE`，返回的 k 行都满足条件；运算符只有 `= != > >= < <=`，最多 16 个元数据列，`LIKE`、`IS NULL` 等会报错或给出错误结果；文档为 v0.1.10-alpha.4。[vec0 文档](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)、[KNN 文档](https://alexgarcia.xyz/sqlite-vec/features/knn.html) | 标签条件是多值集合，加上近似展开和排除，无法写进这几种运算符，仍要先由 Library 算出图片 id 集合；仍是 alpha 版 |
| `usearch` | Apache-2.0，有 Rust crate；`filtered_search` 在遍历图时执行谓词；`exact` 模式绕过索引直接暴力计算；支持 f16／i8；可以 mmap 只读视图。[usearch](https://github.com/unum-cloud/usearch) | 规模扩大后再考虑；谓词过滤在 HNSW 上不保证召回（见[查询语义](query-semantics.md)中 Qdrant 的说明） |
