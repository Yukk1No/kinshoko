# 本地多模态向量检索在高级检索中的位置

调查日期：2026-10-16。问题：以 [DigUp](https://github.com/ARahim3/DigUp) 使用的 EmbeddingGemma 2 为起点，本地图文向量检索在 Kinshoko 的高级检索中处在什么位置，与已在考虑的自动标签、JEV、OpenAI Decisions API 如何分工与组合。

**后续决定：**[待决定问题](local-embedding-search/open-decisions.md)中的问题已于 2026-10-16 讨论，结论见 [Roadmap](../discovery/roadmap.md) 的“以图搜图”“语义搜索”两行与[技术路线](../discovery/technical-route.md)中打标特征的预留；本文保持调研时的原样。

**验证状态：文档与源码已核实，未实测。** 阅读了 DigUp 固定 commit 的源码、Google 官方模型卡与文档、Hugging Face 上相关转换仓库的元数据与说明、DeepGHS 与 PixAI ONNX 导出源码、向量库文档和 RRF 原论文。没有下载模型权重，没有运行 DigUp 或任何模型，没有在验收机器上测速度、显存或检索效果。下文区分三种口径：**来源陈述**（文档、源码可直接证实）、**厂商／作者自报**（未复现的数字）、**适配推论**（本文对 Kinshoko 的判断）。

术语按 [GLOSSARY](../../GLOSSARY.md)。项目背景沿用 [ADR-0003](../adr/0003-tag-identity-and-approximate-search.md)、[ADR-0004](../adr/0004-tech-stack-and-process-model.md)、[技术路线](../discovery/technical-route.md)、[数据与存储模型](../discovery/data-storage-model.md)、[Roadmap](../discovery/roadmap.md)，以及 [Decisions 多模态核查](multimodal-decisions-evaluation.md)、[Jev 适用性](jev-reranker-evaluation.md)、[Jev 社区用途](jev-community-use-cases.md)。

## 目录

- [结论](local-embedding-search/conclusion.md)：向量只做已过滤集合内的排序；标签、排除、分级与安全模式仍先在 Library 内精确过滤。
- [DigUp 设计参照](local-embedding-search/digup.md)：可借鉴的索引、查询与进程分工，以及它和 Kinshoko 模块的对应关系。
- [EmbeddingGemma 2 事实核查](local-embedding-search/embeddinggemma-2.md)：官方资料能确认的模型能力、输入边界、部署形态与仍未证实的事项。
- [打标模型图像特征](local-embedding-search/tagger-image-features.md)：PixAI 等二次元打标模型能否直接提供图片向量，以及提取与指纹约束。
- [目标硬件可行性](local-embedding-search/hardware-feasibility.md)：显存、内存、GPU/CPU 延迟与后台索引对画图的干扰。
- [查询语义](local-embedding-search/query-semantics.md)：向量排序怎样和安全模式、排除、分页、门槛及弱匹配计数组合。
- [分工表](local-embedding-search/division-of-work.md)：自动打标、近似对应、向量索引和 JEV 各自适合的输入、延迟与失败方式。
- [待决定问题](local-embedding-search/open-decisions.md)：需要用户先决策的产品范围、查询姿态、模型路线、技术栈与进程分工。
- [最小实验计划](local-embedding-search/minimal-experiment.md)：用既有样例清单验证特征质量、过滤顺序和硬件预算的最小步骤。
- [未核实事项](local-embedding-search/unverified.md)：仍需实测或补证，不能当作已确认事实的清单。
