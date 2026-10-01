# 候选软件的图像转标签接入核查

核查日期：2026-10-01。用途：支持 Kinshoko 的领域访谈，不在本轮选定模型、推理框架或搜索方案。软件配置以此前调研的固定版本／commit 为准；模型官方资料注明的是本次读取时的声明。仅阅读公开文档、配置、源码和标签元数据，没有下载模型权重、运行图片推理或访问私人图库。

已证实的关键边界：WD 和 Camie 的公开标签接口，主要把一张输入图片映射成固定词表中的标签及分数；公开结果没有同时提供人物实例、区域坐标和各区域的属性关联。标签分类、别名、人工纠错以及组合查询的含义，仍由应用的数据模型与规则决定。[WD 官方推理示例](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)、[Camie 官方 ONNX 推理代码](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/app/utils/onnx_processing.py)

## 1. 各候选实际接入什么

| 软件与核查版本 | 已证实的标签模型／接入 | 检索或其他模型的区别 |
| --- | --- | --- |
| Monbooru `v1.22.0` | 内置目录提供 `SmilingWolf/wd-swinv2-tagger-v3`（目录标为推荐）、`animetimm/eva02_large_patch14_448.dbv4-full`、`fancyfeast/joytag`、`Camais03/camie-tagger-v2`。下载 ONNX 与各自词表／元数据，分别配置阈值；目录存在不等于四项都已安装或运行。[固定目录](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/catalog_default.json) | 标签执行代码使用 ONNX Runtime 的 Go 绑定；这些条目是标签模型，不能据目录推断出 CLIP 搜索能力。[执行代码](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/tagger.go) |
| Project Curator `f98f0b5c1941185ba781cb51963fefe023d42c42` | manifest 包含 Camie v2；同一 commit 还包含标记为 `optional` 的 `ashen-sensored/wd-eva02-tagger-2026-canary`。标签管理器支持两者，结果区分来源。可选项不能直接当成默认安装／启用项。[固定 manifest](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/model_manifest.json)、[标签管理器](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-ml/src/tagger/mod.rs) | `Xenova/clip-vit-base-patch32` 与 `Xenova/mobileclip_s2` 被列为 embedding 模型，产生图像／文字向量。另有独立 YOLO 人物检测与 CCIP 角色聚类管线。[固定管线说明](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/docs/ml/inference_pipelines.md) |
| Blombooru `v1.40.1` | 标签服务列出 SmilingWolf 的 WD EVA02 Large、ViT、SwinV2、ConvNeXt、ViT Large 五个 v3 模型；服务默认参数是 `wd-eva02-large-tagger-v3`。读取 `model.onnx` 与 `selected_tags.csv`，用 `onnxruntime` 的 CPU provider，返回 `name/category/confidence`。[固定服务源码](https://github.com/mrblomblo/blombooru/blob/v1.40.1/backend/app/services/wd_tagger.py) | 这里核实的是标签服务的模型列表与默认参数，未据此判断整个 UI 的默认选择或检索实现。 |
| anime-illust-image-searcher `v1.1.1` | `tagging.py` 使用 `SmilingWolf/wd-eva02-large-tagger-v3`、ONNX Runtime CPU、CSV 词表，经过阈值过滤后把标签文本写入 `tags-wd-tagger.txt`，没有保留每个预测分数。[固定标签源码](https://github.com/ryogrid/anime-illust-image-searcher/blob/v1.1.1/tagging.py) | `genmodel.py` 基于上述标签文本建立 BM25 与 Doc2Vec 索引；这条路径不是直接对图片做 CLIP 向量检索。[固定建索引源码](https://github.com/ryogrid/anime-illust-image-searcher/blob/v1.1.1/genmodel.py) |
| Nephele，官方索引文档最后更新 `2026-09-20` | 文档声明默认 PixAI Tagger v0.9（EVA02，ONNX 本地），未安装升级模型时回落到 WD SwinV2 v3；内容与角色标签按阈值过滤。它是商业软件的官方能力声明，本次没有审计其封闭实现。[官方索引文档](https://nephele.arisfusion.com/zh/docs/indexing) | 同一文档把 CLIP 风格／文字图像检索与内容标签分开，并称 EVA02 图像向量和 CLIP 向量分别保存。不能把这些检索能力归给 WD 标签模型本身。[官方索引文档](https://nephele.arisfusion.com/zh/docs/indexing) |

需要修正此前概括的一处范围：Curator 在固定 commit 中已经包含可选 WD EVA02 2026 Canary；“只接入 Camie”会漏掉这个已存在的选项，但也不能据可选配置声称它默认启用。[固定 manifest](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/model_manifest.json)

## 2. 标签模型、推理引擎与向量检索是不同层次

| 层次 | 输入与输出 | 对 Kinshoko 讨论的含义 |
| --- | --- | --- |
| WD／Camie 等多标签分类模型 | 图片 → 模型词表中各标签的分数 | 负责预测图里可能有哪些标签；词表来自模型配套文件。 |
| ONNX 格式与 ONNX Runtime | 已导出的模型图与输入张量 → 输出张量 | ONNX 是模型表示格式；ONNX Runtime 负责执行及硬件加速。使用这个引擎本身不会决定词表、中文别名、纠错策略或查询语法。 |
| CLIP／MobileCLIP 向量模型及应用的索引 | 图片或文字 → 向量；应用计算相似度并组织结果 | 可以构成另一种语义检索入口；与“解析标签／别名／组合条件后查标签关联”的入口是不同机制。 |

层次区分的直接依据是 [ONNX Runtime 官方说明](https://onnxruntime.ai/docs/) 与 Curator 的 [固定模型 manifest](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/model_manifest.json)、[管线说明](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/docs/ml/inference_pipelines.md)。上述“对 Kinshoko 的含义”是基于接口职责的推论，不是模型选型结论。

## 3. WD／Camie 的公开输出是否包含区域关联

**WD：已核查的官方示例按整张输入图片预处理、补边、缩放并推理，再把 `preds[0]` 与 `selected_tags.csv` 中的标签名逐项配对。**结果分为 rating、general、character 的标签分数字典；接口没有人物实例 ID、bounding box、区域 ID 或“这个人物具有这些属性”的记录。CSV 的 `tag_id` 是标签标识，不是图中人物标识。[WD 官方推理示例](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)、[SwinV2 v3 固定词表](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/selected_tags.csv)

**Camie v2：官方 ONNX 脚本选择 refined predictions，经 sigmoid 转成分数，再用 `idx_to_tag` 和 `tag_to_category` 映射，按每张输入图片返回 `tags/all_probs/all_tags`。**当前公开元数据列出 70,527 个标签；脚本的标签结果没有人物实例与坐标属性关联。模型内部使用图像 patch 或注意力机制，不等于该公开结果接口提供了区域标注。[Camie 固定官方脚本](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/app/utils/onnx_processing.py)、[固定元数据](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json)

与当前痛点直接有关的例子：`blonde_hair`、`blue_hair`、`long_hair`、`short_hair`、`ponytail`、`braid` 在已核查的 WD 词表中都是 category `0`（general），在 Camie 元数据中也都是 `general`。两者没有直接把这些标签组织成用户可见的“发色／发型”分类树。[WD 固定词表](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/selected_tags.csv)、[Camie 固定元数据](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json)

**领域推论：**多人图片中，金发可能属于人物 A，长发可能属于人物 B。因此仅对图片标签做 `金发 AND 长发`，只能表达“这张图同时具有这两个图片级标签”，不能保证同一人物是金发长发。这是输出粒度造成的语义边界，不是一次实验测得的误识别率；是否需要人物／区域关联仍需领域决策。

Curator 的实现进一步提供了对照：`TagPrediction` 只有 `tag/category/confidence`；独立的 `StoredDetection` 才包含 `id/image_id/x0/y0/x1/y1/identity_id`。这证明该项目把标签预测和人物检测建成不同数据结构；本次没有全面验证其人物区域是否还关联其他属性标签。[标签类型](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-ml/src/tagger/types.rs)、[检测类型](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-ml/src/detection/types.rs)

## 4. 哪些规则由应用掌控

以下是接口边界推论；所列开源实现作为可审计例子，不表示 Kinshoko 必须复制其策略。

| 规则 | 边界与证据 |
| --- | --- |
| 模型词表与人工标签 | 模型输出索引依赖配套 CSV／JSON。应用可以允许创建词表外的人工标签，但新增一条数据库标签不会自动给当前模型增加新的预测类别；更换词表也必须与模型输出对应。[WD 示例](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)、[Curator 元数据读取与预测](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-ml/src/tagger/mod.rs) |
| 分类、译名与别名 | 模型的原始 general／character 等类别不直接决定应用的“发色／发型”组织方式。应用可保留原始来源信息并建立自己的分类、展示名和别名映射。Monbooru 写入结果时会把 alias 解析到 canonical tag。[固定标签写入代码](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/tagger.go) |
| 阈值、过滤与候选顺序 | 应用选择模型、阈值、按类别过滤及显示顺序。阈值不是普适常量：Monbooru 目录的 WD character 默认为 `0.50`，Blombooru 标签服务参数为 `0.85`。这些数值不构成跨模型准确度比较。[Monbooru 固定目录](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/catalog_default.json)、[Blombooru 固定服务](https://github.com/mrblomblo/blombooru/blob/v1.40.1/backend/app/services/wd_tagger.py) |
| 接受、修改、拒绝与重新打标 | 保存为建议还是直接写入、是否保留分数、如何保存来源与人工修改、模型重跑时如何处理人工拒绝，都是应用策略。Monbooru 记录 `is_auto/tagger_name/confidence`，重跑不会删除或覆盖已有人工标签；这来自写入逻辑，而非模型能力。人工拒绝是否永久抑制再建议，本次未完整核实。[固定写入逻辑](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/tagger.go) |
| 查询含义 | 标签名称／别名如何解析、多个标签是 AND 还是 OR、是否搜索区域或整图、旧标签如何参加搜索，都属于应用查询语义。CLIP 的相似度入口也不能代替这些明确规则。只实现“标签／别名／组合条件”的文字入口，并不因使用 WD／Camie 而必须引入 CLIP。后一句是职责推论。[标签输出类型](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-ml/src/tagger/types.rs)、[独立向量管线](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/docs/ml/inference_pipelines.md) |

一个可复核的存储取舍：Nephele 文档称它不保存单标签分数，修改阈值后要重新打标；标签来源记录则用于保留人工标签。这说明即使模型输出分数，应用是否保存及利用它仍是独立选择。[官方文档](https://nephele.arisfusion.com/zh/docs/indexing)

## 5. 官方公开性与许可声明

下表只记录官方明确声明和公开文件清单，不给出特定软件／权重组合的法律结论。软件仓库许可证、运行时许可证和模型权重声明应分别核对。

| 模型 | 本次读到的官方声明／公开状态 |
| --- | --- |
| WD SwinV2 v3、WD EVA02 Large v3 | 官方模型卡标注 Apache-2.0；官方库公开列出 ONNX、safetensors、CSV 等文件。[SwinV2 模型卡](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3)、[EVA02 模型卡](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3) |
| animetimm EVA02 dbv4-full | 模型卡标注 GPL-3.0，文件访问有登录／同意条件门禁；本次能读模型卡与文件元数据，未通过门禁读取受限文件。Monbooru 目录也把此项标为 `gated`。[官方模型卡](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full)、[Monbooru 固定目录](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/catalog_default.json) |
| JoyTag | 官方模型卡标注 Apache-2.0；模型库列出 ONNX、safetensors 与 `top_tags.txt`。[官方固定模型卡](https://huggingface.co/fancyfeast/joytag/blob/6b7f16331a6ccf0fdce37d5a9564715f6e772b22/README.md)、[官方文件目录](https://huggingface.co/fancyfeast/joytag/tree/6b7f16331a6ccf0fdce37d5a9564715f6e772b22) |
| Camie v2 | 官方模型卡标注 GPL-3.0；官方库公开提供 ONNX、safetensors、元数据及推理代码。[官方模型卡](https://huggingface.co/Camais03/camie-tagger-v2)、[固定文件目录](https://huggingface.co/Camais03/camie-tagger-v2/tree/7d40c1b85b86ab4f607b2caf26b1b50c99db743e) |
| PixAI Tagger v0.9 | 当前官方模型卡明确写 weights 为 Apache 2.0，文件访问有条件门禁；但官方 `2025-09-10` 公告称 MIT。两处官方声明不一致，本次未读取门禁内文件来消除差异；不能把旧公告的 MIT 无条件当成当前全部权重的声明。[当前模型卡](https://huggingface.co/pixai-labs/pixai-tagger-v0.9)、[官方旧公告](https://pixai.art/zh/news/1922467562068629237) |

## 6. 复现范围与尚未证实的事项

- 固定软件版本不必然固定权重字节：Monbooru 目录使用 HF 的 `resolve/main` 下载地址；Blombooru 和 anime-illust 的下载调用也未指定不可变 HF revision。Curator manifest 同时记录了 SHA-256；本笔记没有执行下载／校验流程。[Monbooru 目录](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/catalog_default.json)、[Blombooru 服务](https://github.com/mrblomblo/blombooru/blob/v1.40.1/backend/app/services/wd_tagger.py)、[anime-illust 标签代码](https://github.com/ryogrid/anime-illust-image-searcher/blob/v1.1.1/tagging.py)、[Curator manifest](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/model_manifest.json)
- 本次 WD 词表读取版本为 `627aef95638667ddcaa3ac8ae625e88ea5b02f51`；Camie 代码与元数据读取版本为 `7d40c1b85b86ab4f607b2caf26b1b50c99db743e`。这些是用于审计本笔记的官方模型仓库版本，不声称就是某位用户此前实际下载的文件版本。
- 没有评测个人参考图库上的发色／发型准确率、多人图属性归属、中文别名覆盖、CPU／GPU 延迟和内存；没有比较模型优劣。候选软件对某模型的接入证明的是可用接入路径，不能替代 Kinshoko 自己的样本验证。
- 没有核实所有模型的训练数据及全部依赖的再分发条件，也没有核实每个候选 UI 的完整默认设置。可选 WD 2026 Canary 的存在已经证实；本轮没有继续做它及所有检测／向量模型的完整许可审计。

供后续领域对齐保留的事实边界：自动标签建议、人工标签、模型分数与来源、标签／别名查询，以及原图关联的局部参考视图，可以由应用分别建模；WD／Camie 的整图标签结果本身不提供人物属性归属，也不负责局部参考的裁切、显示和桌面置顶。这是本轮已读接口所支持的职责边界，不是 Kinshoko 的最终实现规格。

## 进一步选型调研

十个具体标签模型的准确度证据、领域词表、部署方式和性能资料见 [模型选型调研](tagger-model-comparison.md)。该报告记录初筛建议与未知项，尚未选定模型。
