# 2. EmbeddingGemma 2：一手资料能确认什么

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

**查询前缀（来源陈述）。** 模型卡建议文字查询加前缀 `task: search result | query: `，文字文档加 `title: {title} | text: {content}`（无标题时 `title: none`）；图片、视频、音频不加前缀。省略前缀“仍可用，但会降低精度”。[模型卡](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md)。直接调用 ONNX 图时没有任何库会代为加前缀，所以前缀必须由 Kinshoko 写入，并计入向量指纹（第 1 节“模型版本记录”）。

Kinshoko 通过 ort 在 Rust 中运行时，还要自己实现 Gemma 分词（`tokenizer.json`）、Gemma 4 图像预处理（按软 token 预算缩放，每边取 48 px 的整数倍；DigUp 的 [ImageSizing.swift](https://github.com/ARahim3/DigUp/blob/ec28973268b81f836be72187ff23b3a16ef4fd97/Sources/LlamaRuntime/ImageSizing.swift) 移植了这一算法），以及把视觉编码器的输出接入文字图的方式。最后一项的张量契约**未核实**。（适配推论）

---

返回：[《本地多模态向量检索在高级检索中的位置》索引](../local-embedding-search.md)。
