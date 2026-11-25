# 本地多模态向量检索在高级检索中的位置

调查日期：2026-10-16。问题：以 [DigUp](https://github.com/ARahim3/DigUp) 使用的 EmbeddingGemma 2 为起点，本地图文向量检索在 Kinshoko 的高级检索中处在什么位置，与已在考虑的自动标签、JEV、OpenAI Decisions API 如何分工与组合。

**后续决定：**第 7 节的问题已于 2026-10-16 讨论，结论见 [Roadmap](../discovery/roadmap.md) 的“以图搜图”“语义搜索”两行与[技术路线](../discovery/technical-route.md)中打标特征的预留；本文保持调研时的原样。

**验证状态：文档与源码已核实，未实测。** 阅读了 DigUp 固定 commit 的源码、Google 官方模型卡与文档、Hugging Face 上相关转换仓库的元数据与说明、DeepGHS 与 PixAI ONNX 导出源码、向量库文档和 RRF 原论文。没有下载模型权重，没有运行 DigUp 或任何模型，没有在验收机器上测速度、显存或检索效果。下文区分三种口径：**来源陈述**（文档、源码可直接证实）、**厂商／作者自报**（未复现的数字）、**适配推论**（本文对 Kinshoko 的判断）。

术语按 [GLOSSARY](../../GLOSSARY.md)。项目背景沿用 [ADR-0003](../adr/0003-tag-identity-and-approximate-search.md)、[ADR-0004](../adr/0004-tech-stack-and-process-model.md)、[技术路线](../discovery/technical-route.md)、[数据与存储模型](../discovery/data-storage-model.md)、[Roadmap](../discovery/roadmap.md)，以及 [Decisions 多模态核查](multimodal-decisions-evaluation.md)、[Jev 适用性](jev-reranker-evaluation.md)、[Jev 社区用途](jev-community-use-cases.md)。

## 结论

1. **向量相似度是排序，不是条件。** 标签条件、近似查找、排除、内容分级和安全模式都是集合筛选；向量只回答“在这个集合里哪张更像”。正确的组合是**先由 Library 按现有规则算出可见集合，再在集合内精确地按向量排序**。在 1 万～20 万张的规模上，暴力计算整个集合的相似度就够用，不需要近似最近邻（ANN）索引，也就避开了 [Project Curator 先取前 K 再按标签过滤](anime-library-research.md) 的漏图问题。（适配推论，依据见第 5 节）
2. **它补的是现有三种方法都不做的事：本地、离线地用自由描述找图和以图搜图。** 自动标签受固定词表限制；近似对应表只在标签之间展开；JEV 只看文字、在远端运行；Decisions 能看图，但每次只看少量已召回的候选，并且要上传图片。向量检索能对整库做召回，不发送任何数据。[领域对齐 Q5](../discovery/alignment.md) 已把“自由描述检索另行验收”留作待定，向量检索是这项最直接的候选。（适配推论）
3. **EmbeddingGemma 2 的身份、许可证和规格可以从 Google 一手资料确认：** 2026-10-06 发布，Apache 2.0，740M 参数，文字／图片／音频／视频共用 768 维空间，可截短到 512／256／128 维，支持 100 多种语言。官方没有单独提到中文，也没有二次元插画方面的评测。官方 ONNX 不存在；社区有 `onnx-community` 转换，但模型卡明确说 float16 会产生 NaN 或悄悄变差的向量，与该转换给出的 fp16 一致性数字互相矛盾，必须实测。（第 2 节）
4. **DigUp 的工程做法大多能直接对上 Kinshoko 已有的决定：** 模型跑在用完即退出的辅助子进程里（ADR-0004）；向量存在 SQLite，标明生成模型的版本，模型变了就重建（与数据模型中“可重建缓存”一致）；全量暴力打分；先用参考向量和 CPU 结果核对，GPU 结果一致才启用。不能照搬的是推理栈：DigUp 用 llama.cpp + Vulkan，而 Kinshoko 在 [Q67](../discovery/alignment.md) 定了只走 ONNX Runtime + DirectML／Windows ML。（第 1 节）
5. **以图搜图有一条几乎零额外推理成本的路：** 打标模型在出分类结果之前，内部已经算出一个池化后的图像特征。DeepGHS 的 PixAI v0.9 ONNX 直接输出 1024 维 `embedding`；Kinshoko 实际采用的 Mexes PixAI v1.0 ONNX 只输出 `prediction`，这个特征在图里有，但没有作为输出暴露。它只能比较图与图，不能接收文字查询。（第 3 节）
6. **要避免与 ADR-0003 冲突，界面上不能把向量结果说成近似查找。** 近似查找是可见、可改回精确的“任一”标签条件。向量相似结果应当显示为一个独立、可删除的“按描述／按样图排序”条件，带只决定折叠、不移除结果的相近程度门槛，并且从不写入标签或人工标签决定。如果要把文字向量用来为近似查找提候选，就等于新增第三种展开来源，需要重新打开 ADR-0003。（第 6 节）

## 分篇

### 调研依据与可行性

- [DigUp：可借鉴的设计与对应关系](local-embedding-search/digup-design.md)：DigUp 的进程、索引、检索与校验做法。
- [EmbeddingGemma 2：一手资料能确认什么](local-embedding-search/embeddinggemma-2.md)：模型规格、许可证、转换与已确认限制。
- [二次元领域的替代：打标模型自带的图像特征](local-embedding-search/tagger-image-features.md)：PixAI / WD 特征输出与以图搜图路径。
- [在目标硬件上的可行性](local-embedding-search/hardware-feasibility.md)：ONNX Runtime、DirectML／Windows ML 与验收硬件约束。

### 设计分工与验证

- [查询语义：怎样组合向量与集合条件](local-embedding-search/query-semantics.md)：先集合筛选、后向量排序的语义边界。
- [分工表](local-embedding-search/responsibility-split.md)：自动标签、近似查找、JEV、Decisions 与向量检索的分工。
- [需要用户决定的问题](local-embedding-search/open-decisions.md)：当时待决问题；后续决定见索引开头说明。
- [最小实验计划（未执行）](local-embedding-search/minimal-experiment.md)：验证模型、速度、显存与检索效果的最小步骤。
- [未核实事项](local-embedding-search/unverified.md)：本文没有核实或没有复现的事项。
