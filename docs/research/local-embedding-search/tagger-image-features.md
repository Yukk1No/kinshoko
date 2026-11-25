# 3. 二次元领域的替代：打标模型自带的图像特征

[← 返回索引](../local-embedding-search.md)

| 候选 | 来源陈述 | 能做什么 |
|---|---|---|
| PixAI v0.9 DeepGHS ONNX | 导出时用 hook 截取分类头的输入，模型输出 `embedding`、`logits`、`prediction` 三项；`imgutils` 文档说明 `embedding` 是 1024 维，L2 归一化后建议用于相似检索。[导出包装](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/zoo/pixai_tagger/onnx.py)、[调用器文档](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/pixai.py)。Nephele 官方文档称复用同一次推理产生的 EVA02 图像向量做相似检索（已记入[标签模型调研](../tagger-model-comparison.md)） | 只能以图搜图，不接受文字查询 |
| PixAI v1.0 Mexes ONNX（Kinshoko 当前默认） | 导出脚本把 `head_pool`（多头注意力池化，1024 维）的结果送进 `head` 线性层，经 sigmoid 后输出；`output_names=["prediction"]`，**池化特征没有作为输出暴露**。[导出脚本](https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8/blob/0800778563144a0e6fdf41ddadd84aae3cb0dbcf/scripts/export_pixai_v1_onnx.py)、[README](https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8/blob/0800778563144a0e6fdf41ddadd84aae3cb0dbcf/README.md)。Kinshoko 的探测程序本来就会在本机改写这个 ONNX 的 protobuf（分块注意力），并对改写结果做 SHA-256 校验。[patch.rs](../../../tools/tagger-probe/src/patch.rs) | 适配推论：改写时可以顺带把 `head_pool` 的输出加为第二个图输出，几乎不增加推理成本；但改写后的哈希会变，需要重新验证 |
| WD v3 系列 | DeepGHS 另有 `deepghs/wd14_tagger_with_embeddings`，供 `imgutils` 读取 WD 模型的向量。[wd14.py](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/wd14.py) | 后备模型同样可以输出图像特征；未核实具体维数 |
| 二次元 CLIP／SigLIP 微调 | `OysterQAQ/DanbooruCLIP` 基于 CLIP ViT-L/14，用 danbooru2021 和 pixiv 数据微调，2023-07 之后没有更新，**没有声明许可证**，只有 PyTorch 权重。[模型卡](https://huggingface.co/OysterQAQ/DanbooruCLIP)。`animetimm/vit_giantopt_patch16_siglip_384.dbv4-full` 是 SigLIP 骨干的**打标模型**（image-classification），GPL-3.0，设有门禁，不是图文检索模型。[HF API](https://huggingface.co/api/models/animetimm/vit_giantopt_patch16_siglip_384.dbv4-full)。DeepGHS 的 `siglip_onnx` 是 Google 通用 SigLIP 的 ONNX 导出，其中包括 `siglip-base-patch16-256-multilingual`，没有二次元微调。[README](https://huggingface.co/deepghs/siglip_onnx) | 本次**没有找到**同时满足二次元领域、支持中文文字查询、许可证明确、有 ONNX 这四点的一手来源；这不代表不存在 |

适配推论：打标模型的池化特征是为了预测 Danbooru 标签而训练的，相似度更可能反映“标签组合相近”，未必反映构图或氛围相近。EmbeddingGemma 2 是通用领域模型，对二次元插画的效果没有任何公开证据。这两点都只能通过[最小实验计划](minimal-experiment.md)的实验判断。
