# 本地多模态向量检索在高级检索中的位置

调查日期：2026-10-16。问题：以 [DigUp](https://github.com/ARahim3/DigUp) 使用的 EmbeddingGemma 2 为起点，本地图文向量检索在 Kinshoko 的高级检索中处在什么位置，与已在考虑的自动标签、JEV、OpenAI Decisions API 如何分工与组合。

**后续决定：**第 7 节的问题已于 2026-10-16 讨论，结论见 [Roadmap](../discovery/roadmap.md) 的“以图搜图”“语义搜索”两行与[技术路线](../discovery/technical-route.md)中打标特征的预留；本文保持调研时的原样。

**验证状态：文档与源码已核实，未实测。** 阅读了 DigUp 固定 commit 的源码、Google 官方模型卡与文档、Hugging Face 上相关转换仓库的元数据与说明、DeepGHS 与 PixAI ONNX 导出源码、向量库文档和 RRF 原论文。没有下载模型权重，没有运行 DigUp 或任何模型，没有在验收机器上测速度、显存或检索效果。下文区分三种口径：**来源陈述**（文档、源码可直接证实）、**厂商／作者自报**（未复现的数字）、**适配推论**（本文对 Kinshoko 的判断）。

术语按 [GLOSSARY](../../GLOSSARY.md)。项目背景沿用 [ADR-0003](../adr/0003-tag-identity-and-approximate-search.md)、[ADR-0004](../adr/0004-tech-stack-and-process-model.md)、[技术路线](../discovery/technical-route.md)、[数据与存储模型](../discovery/data-storage-model.md)、[Roadmap](../discovery/roadmap.md)，以及 [PR #75](https://github.com/Yukk1No/kinshoko/pull/75) 中尚未合并的三份文档：[Decisions 多模态核查](https://github.com/Yukk1No/kinshoko/blob/2b6a77dc16ac57008f863a8e7f0f8ac67759cafd/docs/research/multimodal-decisions-evaluation.md)、[Jev 适用性](https://github.com/Yukk1No/kinshoko/blob/2b6a77dc16ac57008f863a8e7f0f8ac67759cafd/docs/research/jev-reranker-evaluation.md)、[Jev 社区用途](https://github.com/Yukk1No/kinshoko/blob/2b6a77dc16ac57008f863a8e7f0f8ac67759cafd/docs/research/jev-community-use-cases.md)。

## 结论

1. **向量相似度是排序，不是条件。** 标签条件、近似查找、排除、内容分级和安全模式都是集合筛选；向量只回答“在这个集合里哪张更像”。正确的组合是**先由 Library 按现有规则算出可见集合，再在集合内精确地按向量排序**。在 1 万～20 万张的规模上，暴力计算整个集合的相似度就够用，不需要近似最近邻（ANN）索引，也就避开了 [Project Curator 先取前 K 再按标签过滤](anime-library-research.md) 的漏图问题。（适配推论，依据见第 5 节）
2. **它补的是现有三种方法都不做的事：本地、离线地用自由描述找图和以图搜图。** 自动标签受固定词表限制；近似对应表只在标签之间展开；JEV 只看文字、在远端运行；Decisions 能看图，但每次只看少量已召回的候选，并且要上传图片。向量检索能对整库做召回，不发送任何数据。[领域对齐 Q5](../discovery/alignment.md) 已把“自由描述检索另行验收”留作待定，向量检索是这项最直接的候选。（适配推论）
3. **EmbeddingGemma 2 的身份、许可证和规格可以从 Google 一手资料确认：** 2026-10-06 发布，Apache 2.0，740M 参数，文字／图片／音频／视频共用 768 维空间，可截短到 512／256／128 维，支持 100 多种语言。官方没有单独提到中文，也没有二次元插画方面的评测。官方 ONNX 不存在；社区有 `onnx-community` 转换，但模型卡明确说 float16 会产生 NaN 或悄悄变差的向量，与该转换给出的 fp16 一致性数字互相矛盾，必须实测。（第 2 节）
4. **DigUp 的工程做法大多能直接对上 Kinshoko 已有的决定：** 模型跑在用完即退出的辅助子进程里（ADR-0004）；向量存在 SQLite，标明生成模型的版本，模型变了就重建（与数据模型中“可重建缓存”一致）；全量暴力打分；先用参考向量和 CPU 结果核对，GPU 结果一致才启用。不能照搬的是推理栈：DigUp 用 llama.cpp + Vulkan，而 Kinshoko 在 [Q67](../discovery/alignment.md) 定了只走 ONNX Runtime + DirectML／Windows ML。（第 1 节）
5. **以图搜图有一条几乎零额外推理成本的路：** 打标模型在出分类结果之前，内部已经算出一个池化后的图像特征。DeepGHS 的 PixAI v0.9 ONNX 直接输出 1024 维 `embedding`；Kinshoko 实际采用的 Mexes PixAI v1.0 ONNX 只输出 `prediction`，这个特征在图里有，但没有作为输出暴露。它只能比较图与图，不能接收文字查询。（第 3 节）
6. **要避免与 ADR-0003 冲突，界面上不能把向量结果说成近似查找。** 近似查找是可见、可改回精确的“任一”标签条件。向量相似结果应当显示为一个独立、可删除的“按描述／按样图排序”条件，带相近程度门槛，并且从不写入标签或人工标签决定。如果要把文字向量用来为近似查找提候选，就等于新增第三种展开来源，需要重新打开 ADR-0003。（第 6 节）

## 1. DigUp：可借鉴的设计与对应关系

DigUp 是 MIT 许可的桌面文件语义检索工具，仓库创建于 2026-10-08；本文固定在 [`ec28973`](https://github.com/ARahim3/DigUp/tree/ec28973268b81f836be72187ff23b3a16ef4fd97)（2026-10-14，对应发布 v0.7.0-beta.1）。下面的数字都来自作者源码注释或 README，属于作者自报，本次没有复现。

| 设计点 | 来源陈述 | 对 Kinshoko 的对应 |
|---|---|---|
| 模型构件 | 下载 `ggml-org/embeddinggemma-2-GGUF` 固定修订 `bfcd298` 中的 **Q8_0** 两个文件：文字部分 `embeddinggemma-2-Q8_0.gguf`（309,855,456 字节）和图像／音频编码器 `mmproj-embeddinggemma-2-Q8_0.gguf`（554,821,024 字节），各带 SHA-256；注释说明它们由 `google/embeddinggemma-2` 的 `914f7f8` 转换而来，并且**不用 F16 文件，因为模型激活值会溢出 float16**。[ModelFiles.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/ModelFiles.swift)、[GGUF 仓库文件](https://huggingface.co/api/models/ggml-org/embeddinggemma-2-GGUF/revision/bfcd298762cc34d0357ece5ebdd31791a3a374d8?blobs=true) | 与 Kinshoko 现有的模型分发方式（固定版本、校验哈希、首次使用时下载）一致，见[技术路线](../discovery/technical-route.md) |
| 辅助子进程 | Tauri 外壳启动两个辅助进程：`digup search-service` 负责回答查询，`digup index-service` 负责更新索引、做完就退出；在 Windows 上，这两个进程放进随外壳一起关闭的 job 中，后台工作用低于正常的优先级。[helper.rs](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/shell/src-tauri/src/helper.rs)、[IndexService.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/digup/IndexService.swift)。README 说，只有在搜索时才加载文字部分（约 250 MB）；模型完整加载约 1 GB，只加载文字部分约 0.25 GB。[README](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/README.md)、[LlamaEmbedder.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/LlamaRuntime/LlamaEmbedder.swift) | 与 [ADR-0004](../adr/0004-tech-stack-and-process-model.md) 的打标子进程同构：建索引可以放进同一个子进程，或使用同样的子命令机制；查询时的文字编码放在哪个进程，ADR-0004 还没有回答（见第 4 节） |
| GPU 选择 | `digup speed --model` 先只用 CPU 跑一遍，再用 GPU 跑；**只有 GPU 向量与 CPU 向量的最低余弦 ≥ 0.999，且 GPU 不比 CPU 慢**时，才在之后的辅助进程里使用 GPU。注释记录了两个反例：i5-8350U 的 UHD 620 走 Vulkan 用了 76 秒，而 CPU 只要 44 秒；Mesa lavapipe 给出的图片与声音向量余弦只有 0.94–0.97。[main.swift L503–L561](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/digup/main.swift#L503-L561)、[ModelSpeed.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/digup/ModelSpeed.swift) | 与 #6 打标验收“核对与 CPU 结果一致，确认没有静默回落 CPU”（[验收约定](../validation/acceptance.md)）是同一种门槛，可以沿用到向量模型上 |
| 运行时回归 | `ReferenceVectorTests` 要求每次更新 llama.cpp 都重现存档的参考向量（余弦 ≥ 0.999），否则就提升 `vectorVersion`，让所有索引重新生成向量。[LlamaEmbedder.swift L15–L31](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/LlamaRuntime/LlamaEmbedder.swift#L15-L31)、[ReferenceVectorTests.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Tests/LlamaRuntimeTests/ReferenceVectorTests.swift) | 升级 ort 或 DirectML 时也需要同类测试 |
| 存储 | 一个 SQLite 文件；`segments.vec` 是 768 个 float16 组成的 BLOB，向量已 L2 归一化；另有 FTS5 关键词表。[IndexStore.swift L125–L136](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/IndexStore.swift#L125-L136) | 对应[数据与存储模型](../discovery/data-storage-model.md)中可清理、可重建的“全文／向量索引缓存” |
| 模型版本记录 | 索引的 `meta` 表保存 `vector_source`（模型＋修订＋运行时＋精度）和 `fingerprint`（另加图像 token 预算等影响向量的设置）；两者不匹配时清空并重建，不混用。[Indexer.swift L294–L320](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/Indexer.swift#L294-L320)、[Model.swift L36–L86](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/Model.swift#L36-L86) | 可以直接借鉴：向量缓存键里要写入模型修订、预处理、维数和精度 |
| 检索方式 | **全量暴力计算**：把全部 float16 向量按 1024 行分块转成 float32 后与查询向量做点积；没有 ANN。作者实测 7 万个向量占 108 MB，而 float32 要 215 MB，换来每次查询多约 2 ms。按文件类型过滤时，是在全部打分之后筛掉，所以过滤结果是精确的。[Vectors.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/Vectors.swift)、[Searcher.swift L115–L130、L292–L310](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/Searcher.swift#L115-L130) | 支持第 4、5 节的判断：在这个规模下，暴力计算加精确预过滤是可行的 |
| 混合打分 | 先把余弦减去所在模态的均值，再除以整体标准差，得到 z 分；只有 z ≥ 2 才算语义命中（`zGate`），所以能如实给出“没找到”。关键词覆盖率作为加分项。作者记录这种做法在自己的两套评测上胜过 RRF：R@1 0.88 对 0.73（合成集），0.86 对 0.82（真实集）。得分不到第一名一半的结果折叠为“较弱匹配”。[Searcher.swift L26–L31、L170–L180、L280–L290、L315–L345](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/Searcher.swift#L170-L180) | 门槛与折叠是展示向量结果的关键（第 6 节）。z 分的统计范围要限制在安全模式下可见的集合内，见第 5 节 |
| 评测 | `evals/*.json` 每条查询记为 `{q, expect, tag}`；`digup eval` 输出各 tag 的 R@1／R@5／R@10／MRR。多语言评测只覆盖英语、孟加拉语和阿拉伯语。[evals/](https://github.com/ARahim3/DigUp/tree/ec28973268b81f836be72187ff23b3a16ef4fd97/evals)、[main.swift `evaluate`](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/digup/main.swift#L599-L690) | 第 8 节实验借用这种格式 |

README 还说明：在 Windows 和 Linux 上，只有 GPU 更快时才用 GPU，否则用 CPU；只用 CPU 时，一张图片要几秒，2017 年笔记本的 Core i5 约 5 秒。中文、日文、泰文等不以空格分词的语言，在精确词匹配部分不会被切词。[README](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/README.md)。第二点对 Kinshoko 影响不大：Kinshoko 的精确匹配本来就由标签与中文别名承担。（适配推论）

DigUp README 称 EmbeddingGemma 2 采用 Apache 2.0。经 Google 一手资料核对，这一说法**正确**（见第 2 节）。

## 2. EmbeddingGemma 2：一手资料能确认什么

| 项目 | 来源陈述 |
|---|---|
| 身份与日期 | Google DeepMind 博客 2026-10-06 发布，作者 Sahil Dua、Henrique Schechter Vera；基于 Gemma 4 架构。[官方博客](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2)。HF 仓库 `google/embeddinggemma-2` 当前修订为 `914f7f8`，未设门禁。[HF API](https://huggingface.co/api/models/google/embeddinggemma-2) |
| 许可证 | 模型卡、Google 文档和博客都写 **Apache 2.0**。模型卡的链接文字是“Apache 2.0”，实际指向 `gemma_4_license`，该页面展示的正文是 Apache License 2.0。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md)、[Gemma 4 license 页](https://ai.google.dev/gemma/docs/gemma_4_license)、[Google 文档](https://ai.google.dev/gemma/docs/embeddinggemma)。另外，模型卡写有“部署须遵守 Gemma Prohibited Use Policy”。该政策禁止生成色情内容，同时注明艺术用途除外；政策正文没有说明它与 Apache 许可证的关系。[政策](https://ai.google.dev/gemma/prohibited_use_policy)。Kinshoko 只用它为画师自己的参考图生成向量，并不生成内容；这一条款是否对 Kinshoko 有实际约束，**未作法律判断** |
| 规模 | 共 740M 参数：文字骨干 130M、embedder 140M、视觉编码器 170M、音频编码器 300M。只用文字时约 270M，文字＋图像约 440M。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md) |
| 模态与维数 | 文字（含代码）、图片、视频、音频，可以单独输入，也可以交错组合输入，统一映射到 768 维；支持 Matryoshka 截短到 512／256／128 维，截短后需要重新归一化，查询与文档不能混用不同维数。上下文 8,192 token；图片默认 280 个软 token，可在 70–1120 之间选。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md) |
| 语言 | 模型卡称理解 100 多种语言，训练数据覆盖 140 多种，并说明各语言表现可能不一致。模型卡、Google 文档和博客都**没有点名中文**，也没有按语言列出成绩。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md)、[Google 文档](https://ai.google.dev/gemma/docs/embeddinggemma) |
| 评测（厂商自报，768 维） | MIEB lite 64.64；MMEB v2 Image Hit@1 57.28；MMEB v2 VisDoc NDCG@5 67.84；MTEB 多语言 61.36。截短到 256 维时，MIEB lite 63.13、MMEB 总分 56.24；到 128 维时 MMEB 总分降为 45.65，模型卡说明 128 维会明显损害多模态质量。没有 COCO、Flickr、XM3600 这类单独的图文检索表，也没有动画或插画领域的评测。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md) |
| 精度 | “用 bfloat16 或 float32 推理，不要用 float16”；在 float16 下模型会返回 NaN，或悄悄给出变差的向量。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md) |
| 安全 | 只做了预训练数据过滤，没有后训练对齐；模型卡写明“检索过滤”等应用层防护由部署方负责。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md) |
| 官方运行时 | 博客列出 transformers、sentence-transformers、MLX、vLLM、llama.cpp（GGUF）、Ollama、LiteRT、transformers.js 与 WebGPU 等，**没有提到 ONNX**；官方仓库只发布 safetensors。[官方博客](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2)、[HF API 文件列表](https://huggingface.co/api/models/google/embeddinggemma-2) |
| ONNX | `onnx-community/embeddinggemma-2-ONNX`，修订 `daa72c5`，面向 transformers.js，由 Xenova 提交。模型拆为 `model`、`vision_encoder`、`audio_encoder` 三个图，每个图都有 fp32／fp16／q8（`quantized`）／q4／q4f16 版本。fp32 的文字图约 1.08 GB、视觉图约 0.67 GB；q8 分别约 0.31 GB 和 0.20 GB。README 给出各精度相对 fp32 的最差余弦：fp16 0.9998，q8 0.9997，q4 0.975；没有说明测法，**也没有 ONNX Runtime 原生调用示例或输入输出张量名**。[README](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/blob/daa72c51243991dfcaf9f9137d2c573d8f7790c0/README.md)、[文件元数据](https://huggingface.co/api/models/onnx-community/embeddinggemma-2-ONNX/revision/daa72c51243991dfcaf9f9137d2c573d8f7790c0?blobs=true) |

**矛盾需要实测：** 官方模型卡说 float16 会出 NaN 或悄悄变差，ONNX 转换方却报告 fp16 最差余弦 0.9998；DigUp 也因溢出问题不用 F16。两者可能在不同的图上保留了 fp32 计算，无法从文档判断。在 DirectML 上用 fp16，必须按 DigUp 的做法与 CPU fp32 的参考向量逐项比较。（适配推论）

Kinshoko 通过 ort 在 Rust 中运行时，还要自己实现 Gemma 分词（`tokenizer.json`）、Gemma 4 图像预处理（按软 token 预算缩放，每边取 48 px 的整数倍；DigUp 的 [ImageSizing.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/LlamaRuntime/ImageSizing.swift) 移植了这一算法），以及把视觉编码器的输出接入文字图的方式。最后一项的张量契约**未核实**。（适配推论）

## 3. 二次元领域的替代：打标模型自带的图像特征

| 候选 | 来源陈述 | 能做什么 |
|---|---|---|
| PixAI v0.9 DeepGHS ONNX | 导出时用 hook 截取分类头的输入，模型输出 `embedding`、`logits`、`prediction` 三项；`imgutils` 文档说明 `embedding` 是 1024 维，L2 归一化后建议用于相似检索。[导出包装](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/zoo/pixai_tagger/onnx.py)、[调用器文档](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/pixai.py)。Nephele 官方文档称复用同一次推理产生的 EVA02 图像向量做相似检索（已记入[标签模型调研](tagger-model-comparison.md)） | 只能以图搜图，不接受文字查询 |
| PixAI v1.0 Mexes ONNX（Kinshoko 当前默认） | 导出脚本把 `head_pool`（多头注意力池化，1024 维）的结果送进 `head` 线性层，经 sigmoid 后输出；`output_names=["prediction"]`，**池化特征没有作为输出暴露**。[导出脚本](https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8/blob/0800778563144a0e6fdf41ddadd84aae3cb0dbcf/scripts/export_pixai_v1_onnx.py)、[README](https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8/blob/0800778563144a0e6fdf41ddadd84aae3cb0dbcf/README.md)。Kinshoko 的探测程序本来就会在本机改写这个 ONNX 的 protobuf（分块注意力），并对改写结果做 SHA-256 校验。[patch.rs](../../tools/tagger-probe/src/patch.rs) | 适配推论：改写时可以顺带把 `head_pool` 的输出加为第二个图输出，几乎不增加推理成本；但改写后的哈希会变，需要重新验证 |
| WD v3 系列 | DeepGHS 另有 `deepghs/wd14_tagger_with_embeddings`，供 `imgutils` 读取 WD 模型的向量。[wd14.py](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/wd14.py) | 后备模型同样可以输出图像特征；未核实具体维数 |
| 二次元 CLIP／SigLIP 微调 | `OysterQAQ/DanbooruCLIP` 基于 CLIP ViT-L/14，用 danbooru2021 和 pixiv 数据微调，2023-07 之后没有更新，**没有声明许可证**，只有 PyTorch 权重。[模型卡](https://huggingface.co/OysterQAQ/DanbooruCLIP)。`animetimm/vit_giantopt_patch16_siglip_384.dbv4-full` 是 SigLIP 骨干的**打标模型**（image-classification），GPL-3.0，设有门禁，不是图文检索模型。[HF API](https://huggingface.co/api/models/animetimm/vit_giantopt_patch16_siglip_384.dbv4-full)。DeepGHS 的 `siglip_onnx` 是 Google 通用 SigLIP 的 ONNX 导出，其中包括 `siglip-base-patch16-256-multilingual`，没有二次元微调。[README](https://huggingface.co/deepghs/siglip_onnx) | 本次**没有找到**同时满足二次元领域、支持中文文字查询、许可证明确、有 ONNX 这四点的一手来源；这不代表不存在 |

适配推论：打标模型的池化特征是为了预测 Danbooru 标签而训练的，相似度更可能反映“标签组合相近”，未必反映构图或氛围相近。EmbeddingGemma 2 是通用领域模型，对二次元插画的效果没有任何公开证据。这两点都只能通过第 8 节的实验判断。

## 4. 在目标硬件上的可行性

**显存与内存（来源陈述＋推论）。** PixAI v1.0 FP16 分块版在 RX 6500 XT 4 GB 上峰值约 1.6 GB，约 2.75 秒一张；没有独显时，FP32 在 CPU 上约 29 秒一张、约 4.6 GB 内存（[验收约定](../validation/acceptance.md)）。EmbeddingGemma 2 的 ONNX 文字图加视觉图，在 fp32 下文件合计约 1.75 GB，q8 约 0.51 GB（第 2 节）；文件大小不等于显存需求，[标签模型调研](tagger-model-comparison.md)已经说明过这一点。两个模型能否同时放进 4 GB 显存，**未实测**。保守做法是在同一个子进程里先后加载：打完一批标签、卸载打标模型，再生成向量。

**单张成本（作者自报）。** DigUp 在 M4 Pro（Metal、Q8_0、140 软 token）上约 0.12 秒一张图；在 2017 年 Core i5 上只用 CPU 约 5 秒。[ModelSpeed.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/digup/ModelSpeed.swift)、[README](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/README.md)。DirectML 和 RX 6500 XT 上的数字未知。q8 的 `MatMulNBits`／动态量化算子在 DirectML 上是否会回落到 CPU，**未核实**。

**子进程（适配推论）。** 建索引放进 ADR-0004 的打标子进程最自然：同样隔离崩溃，“画师绘画时暂停或结束子进程”的策略也一起覆盖。查询时的文字编码是另一回事。约 270M 参数的文字部分，每次查询都要算一次，作为排序输入，延迟必须在“交互响应约 100 ms”的预算内（[验收约定](../validation/acceptance.md#交互响应)）。可以借 DigUp 的做法，增加一个常驻的查询子进程；也可以在主进程里只用 CPU 跑文字图。后者改变了 ADR-0004 “推理不进主进程”的前提，需要另行决定。PixAI 特征方案只做以图搜图，不需要查询时推理，这个问题也就不存在。

**索引（来源陈述＋推论）。** DigUp 实测 7 万个 768 维 float16 向量占 108 MB，暴力查询多出的时间在毫秒级（第 1 节）。按同样的比例推算，20 万张图在 768 维时约 0.3 GB，截短到 256 维约 0.1 GB；用 PixAI 的 1024 维特征约 0.4 GB。这些是算术估计，不是实测。Rust 侧有三种可选做法：

| 方式 | 来源陈述 | 适配 |
|---|---|---|
| SQLite BLOB＋Rust 暴力计算 | DigUp 的做法（第 1 节） | 过滤集合由 Library 计算，最直接；20 万张时可以把 float16 矩阵放进内存，或分块读取 |
| `sqlite-vec` 的 `vec0` | 元数据列可以写进 KNN 查询的 `WHERE`，返回的 k 行都满足条件；运算符只有 `= != > >= < <=`，最多 16 个元数据列，`LIKE`、`IS NULL` 等会报错或给出错误结果；文档为 v0.1.10-alpha.4。[vec0 文档](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)、[KNN 文档](https://alexgarcia.xyz/sqlite-vec/features/knn.html) | 标签条件是多值集合，加上近似展开和排除，无法写进这几种运算符，仍要先由 Library 算出图片 id 集合；仍是 alpha 版 |
| `usearch` | Apache-2.0，有 Rust crate；`filtered_search` 在遍历图时执行谓词；`exact` 模式绕过索引直接暴力计算；支持 f16／i8；可以 mmap 只读视图。[usearch](https://github.com/unum-cloud/usearch) | 规模扩大后再考虑；谓词过滤在 HNSW 上不保证召回（见第 5 节 Qdrant 的说明） |

## 5. 查询语义：怎样组合向量与集合条件

**一手来源中的组合方式：**

- **先过滤后排序（预过滤）。** `sqlite-vec` 承诺，带元数据约束的 KNN 最多返回 k 行，而且全部满足约束（[vec0](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)）。DigUp 先对全部向量打分，再只保留允许的文件类型，效果相同（[Searcher.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/DigUpKit/Searcher.swift#L115-L130)）。
- **先取前 K 再过滤（后过滤）。** Project Curator 先取有限数量的向量候选，再做标签过滤，条件严格时会漏掉候选范围以外的符合图（[anime-library-research](anime-library-research.md)）。Qdrant 用索引估计过滤条件的基数：满足条件的点少于阈值时改走全量扫描，否则走带过滤边的 HNSW。它的文档也承认，多个严格条件同时生效时，图仍可能断开。[Qdrant Indexing](https://qdrant.tech/documentation/manage-data/indexing/)
- **混合打分。** DigUp 把语义 z 分与关键词覆盖率相加（第 1 节）。
- **倒数排名融合（RRF）。** 对每个文档计算 Σ 1/(k + r(d))，原文 k = 60，是在预实验中定下的，不针对数据调参；论文称在 TREC 数据上胜过各单一系统和 Condorcet。[Cormack, Clarke, Büttcher, SIGIR 2009](http://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)。DigUp 作者在自己的评测上发现 RRF 不如 z 分加分（作者自报）。

**与 Kinshoko 现有规则的关系（适配推论）：**

| 现有规则 | 向量检索必须遵守的做法 |
|---|---|
| 安全模式 | 安全模式在 Library 内由浏览视角执行，被封印的图不出现在结果、计数和候选中（[技术路线](../discovery/technical-route.md)、[验收约定](../validation/acceptance.md#内容分级与安全模式)）。因此向量只能对浏览视角给出的可见 id 集合打分，**禁止**先取前 K 再过滤。z 分、相近程度门槛、“较弱匹配”数量等**统计也只能按可见集合计算**：如果统计里包含被封印的图，可见结果的门槛会随隐藏图变化，间接透露它们的存在。以一张图搜相似图时，查询图本身必须是可见图。成人图的向量照常保存在本地缓存中，这与标签数据的处理一致；向量缓存不能成为绕过分级的出口，例如“相似图数量”这类计数。 |
| 内容分级 | 分级仍来自打标模型的 `rating` 输出和人工修正。向量模型不承担分级：模型卡说明它没有安全调优，训练数据也做过过滤（第 2 节），对成人插画的表示质量未知。 |
| 排除条件 | 标签排除是确定的集合减法，先于排序执行。向量不能表达“不要多人”这类否定：把否定词写进描述，只会改变向量的方向，不会真正排除。这一点没有找到 EmbeddingGemma 2 的专门说明，是推论，需要实测。界面上应引导用户用标签来排除。 |
| 近似查找 | 近似查找只展开标签条件，是可见、可改回精确的“任一”条件（[ADR-0003](../adr/0003-tag-identity-and-approximate-search.md)）。向量排序作用在展开后的集合上，两者互不改写。 |
| 多条件默认同时满足 | 带描述的查询等于“标签条件集合 ∩ 相近程度超过门槛的图”，再按相近程度排序。门槛决定结果是否完整，需要按第 8 节实验来定。 |

## 6. 分工表

| 方法 | 输入 | 本地／远端 | 成本 | 延迟级别 | 主要失败方式 | 适合的任务 |
|---|---|---|---|---|---|---|
| 自动标签（PixAI v1.0，打标子进程） | 图片 → 固定词表标签＋分级 | 本地 | 每张图一次：GPU 约 2.75 秒，CPU 约 29 秒（[验收约定](../validation/acceptance.md)） | 导入后的批处理 | 词表缺口（如 v1.0 未检出中分）、错标；在人工决定下可纠正 | 自动标签建议、内容分级；为集合筛选提供基础 |
| 内置／个人近似对应表 | 标签 id 与外部对应 | 本地 | 免费 | 即时 | 覆盖面不足（首批只有四类）；没有外部对应的标签不参与内置表 | 近似查找展开（首版） |
| JEV（PR #75） | 文字：查找词与库内标签名；不收图片 | 远端，用户自填 key | 输入 $0.042／百万 token（[Decisions 核查](https://github.com/Yukk1No/kinshoko/blob/2b6a77dc16ac57008f863a8e7f0f8ac67759cafd/docs/research/multimodal-decisions-evaluation.md)） | 网络往返 | 不可用时退回内置近似对应表；误判；会发送标签名，安全模式下不发送成人标签（ADR-0003） | 近似查找候选（已确认）；文字信息足够时，对已召回候选做小判断 |
| Decisions（PR #75） | 文字＋Base64 图片，每次最多 128 张 | 远端，public beta | 输入 $0.10／百万 token，无输出费用 | 网络往返＋上传 | 拒答、超时、beta 变动、上传图片的隐私问题；概率未在本项目校准 | 对少量已召回候选的看图小判断或重排 |
| 本地向量：EmbeddingGemma 2 | 图片与文字都映射到同一空间 | 本地 | 首次下载约 0.5–1.75 GB；每张图生成一次向量，在 Kinshoko 硬件上耗时未知（DigUp 的 CPU 数字是数秒）；索引 0.1–0.3 GB | 建索引是批处理；查询时编码一次文字＋毫秒级打分 | 排错了也不会报错；没有门槛时永远有“结果”；中文与二次元领域效果未知；fp16 数值风险 | 用描述找图；以图搜图／找相似参考；在标签筛出的集合内排序；为 Decisions 提供召回候选 |
| 本地向量：打标模型池化特征 | 只有图片 | 本地 | 几乎不增加推理；需要改写 ONNX 输出 | 与打标同时完成 | 只能以图搜图；相似度可能偏向标签组合 | 以图搜图／找相似参考 |

**重叠与冲突：**

- **与 ADR-0003 的冲突点。** 近似查找的定义是“把相近的**标签**作为任一条件”，是可见、可编辑的布尔展开。向量相似结果不是标签条件：它无法逐项展示、无法改回精确，也不对应任何标签。因此 **(a)** 不要把向量结果命名为近似查找或混进近似展开的显示；**(b)** 在条件栏里把它显示为独立、可删除的排序条件，例如“按描述：‘逆光下的侧脸’”或“像这张图”，并给出相近程度门槛；**(c)** 永远不把向量结果写成标签、自动标签建议或人工标签决定。如果用标签名的文字向量去生成近似候选（作用与 JEV 相同），那就是第三种展开来源。ADR-0003 现在规定“两种来源二选一”，这样做需要重新打开它。（适配推论）
- **与 JEV 的重叠。** 两者都能从查找词出发去找相近的标签名。JEV 在远端，要用户自填 key，并且有公开的校准说明；文字向量在本地、免费，但没有判断语义。在同一项任务上比较，属于 PR #75 已经提出的“按用途比较后端”。
- **与 Decisions 的分工。** 向量负责整库召回，Decisions 负责对前 N 张做看图的小判断。只有在用户主动开启、并清楚哪些图会被上传时，两者才组合；安全模式开启时，成人图不应进入上传候选。这条约束沿用 ADR-0003 对 JEV 的处理，图片上传的具体规格还没有定（[Decisions 核查](https://github.com/Yukk1No/kinshoko/blob/2b6a77dc16ac57008f863a8e7f0f8ac67759cafd/docs/research/multimodal-decisions-evaluation.md)）。
- **与自动标签的重叠。** EmbeddingGemma 2 原则上可以拿标签名做零样本分类，从而补出“自动标签建议”。但这样会与已定的 PixAI 词表和阈值规则形成两套来源，本文不建议这样用。
- **附带用途。** [数据与存储模型](../discovery/data-storage-model.md)规定，感知相似度只用来为合并去重找候选，最终以字节核验为准；图像向量可以充当这里的候选来源，不影响身份判定。

## 7. 需要用户决定的问题（供后续 `/grill-with-docs`）

1. 自由描述找图和以图搜图，是否作为 roadmap 中的明确能力？是并入“高级检索与辅助候选”，还是单独成行？
2. 向量结果在界面上的形态：只作为排序？还是作为带门槛、可删除的条件？没有任何标签条件时，是否允许单独用描述查找？
3. 模型路线：通用的 EmbeddingGemma 2（文字＋图片）、打标模型池化特征（只有图片、几乎免费），还是两者都要？
4. 推理栈：坚持 Q67 的 ONNX Runtime + DirectML／Windows ML，还是允许像 DigUp 一样增加 llama.cpp／Vulkan？后者会重开 Q67，并增加第二套 GPU 验收。
5. 进程：建索引是否并入打标子进程？查询时的文字编码放在常驻查询子进程里，还是在主进程中用 CPU 运行？后者涉及 ADR-0004。
6. 是否允许用文字向量为近似查找生成候选？这会重开 ADR-0003 的“两种来源二选一”。
7. 下载与磁盘预算：打标模型已经约 3 GB，再加 0.5–1.75 GB 是否可以接受？是否做成可选组件？
8. 向量索引放在可清理、备份可省略的缓存里，还是作为需要保护的派生数据？重新生成 20 万张图的向量可能要数小时。
9. 向量召回加 Decisions 重排的组合，在上传图片方面如何征得同意、设定什么范围？

## 8. 最小实验计划（未执行）

样本使用现有清单：[`sample-manifest.pixiv.json`](../validation/sample-manifest.pixiv.json) 共 238 张（evaluation 185 张，calibration 53 张），覆盖维度包括 `hair:*`、`style:twintails／ponytail`、`bangs:blunt／hime／middle-part`、`length:*`、`lineart`、`grayscale`、`thick-paint`、`backlight`、`multi-person`、`full-body`、`very-tall` 等；[`sample-manifest.pixiv-r18.json`](../validation/sample-manifest.pixiv-r18.json) 共 14 张。覆盖维度和作者标签都只是弱真值（[验收约定](../validation/acceptance.md)）。

1. **文字找图。** 从覆盖维度生成查询，每个维度分别写中文、日文和英文版本，例如“双马尾”“ツインテール”“twintails”“逆光”“黑白线稿”；所有带该维度的 evaluation 样本都视为期望结果。仿照 DigUp `evals` 的格式记为 `{q, expect, tag}`。比较四种做法：(a) PixAI 标签＋翻译表的精确条件；(b) 只用 EmbeddingGemma 2 的文字查询；(c) 先按标签筛选再用向量排序；(d) 用 RRF 或 z 分加分做融合。记录 R@10、MRR，并按语言分别统计。
2. **以图搜图。** 用 calibration 样本作查询图，与它共享覆盖维度的 evaluation 样本作期望结果。比较 EmbeddingGemma 2 的图像向量、PixAI 池化特征（需要额外暴露输出），以及 Monbooru 式标签集合 Dice 系数基线（[anime-library-research](anime-library-research.md)）。
3. **维数。** 在实验 1 和 2 上比较 768／512／256 维。
4. **安全模式泄漏。** 把 r18 清单与 `sensitive` 样本一起放进库，开启安全模式后跑完实验 1 和 2 的全部查询。断言结果、计数与“较弱匹配”中都没有被封印的图；断言门槛与 z 分只按可见集合计算；断言设定返回 k 张时，确实拿到 k 张可见图（不因过滤而缩水）。
5. **运行与数值。** 在验收机器（RX 6500 XT 4 GB）和一台无独显机器上，对 fp32、fp16、q8 各做一遍：按 DigUp 的门槛，与 CPU fp32 参考向量比较，最低余弦须 ≥ 0.999；检查 NaN；确认没有算子回落 CPU；记录每张图 p50／p95、峰值显存与内存、与 PixAI 同时加载还是先后加载、查询时文字编码的延迟。

**记录与判定：** 按[验收约定](../validation/acceptance.md)的方式保存首版与修正版两份数字。是否保留某个方案，看“这一屏值得刷吗”的画师反馈和召回指标，而不是看模型榜单。

## 未核实事项

- EmbeddingGemma 2 的中文效果、二次元插画上的效果，以及对成人插画的表示质量。
- `onnx-community` ONNX 的输入输出张量契约、各精度在 DirectML 上的数值与算子回落情况，以及 fp16 与官方警告之间的矛盾。
- EmbeddingGemma 2 在验收硬件上的速度与显存，以及能否与 PixAI 同时驻留显存。
- 把 PixAI v1.0 的 `head_pool` 输出加为图输出是否可行，以及它在以图搜图上的效果。
- 向量描述能否表达否定和排除（推论为不能）。
- `deepghs/wd14_tagger_with_embeddings` 的具体维数与修订。
- Gemma Prohibited Use Policy 对 Apache 2.0 模型的约束力。
