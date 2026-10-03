# Kinshoko 标签模型选型调研

研究日期：2026-10-01。研究目标是缩短二次元画师在自己的参考图库中按发色、发型和眼睛特征找参考的时间，并支持之后选择整图或局部参考视图。本文是选型依据与后续评估建议，尚未选定模型或项目技术栈。

## 阅读结论

本次覆盖前轮提到的十个具体标签模型：WD v3 的五个变体、WD EVA02 2026 Canary、animetimm EVA02 dbv4-full、JoyTag、Camie v2、PixAI v0.9。ONNX Runtime 是运行时；CLIP／MobileCLIP 等向量检索模型不属于这份标签模型对照的范围。

公开资料能够确定词表、部署格式、下载体积和作者评测成绩；目前没有足够的同机证据来给十个模型排出可靠的 Windows 延迟、吞吐和峰值内存榜，也没有它们在你们参考图库上的准确率。

本次建议首轮验证四项：**PixAI v0.9 作为优先验证的产品方案候选，WD SwinV2 v3 作为较小下载体积的基线与兜底对照，WD EVA02 Large v3 作为同系列准确度对照，Camie v2 作为细分词表候选。**这是待实测的分工，不是总体准确度排名或已选定的默认模型。带 `middle_part` 的 Canary 保留为后续词表扩展候选。

验证理由：Nephele 的官方文档将 PixAI v0.9 设为内容识别主模型，保留 WD SwinV2 v3 兜底，并复用同一次推理产生的 EVA02 图像向量进行相似检索。这是同类产品的采用信号，应纳入 PixAI 的验证优先级；本次没有获得其完整选型对照实验或独立性能验证。WD 两项适合控制词表变量；Camie 则能用于检验更细词表的价值。[Nephele 索引说明](https://nephele.arisfusion.com/zh/docs/indexing)

首轮建议修正说明（2026-10-01）：前一版较重视公开评测可比性、精确标签覆盖与原生文件获取，低估了同类产品已接入 PixAI 的信号。缺少发型专项成绩、精确 `middle_part` 或原库访问门禁，都是需验证／处理的事项，不能据此推断 PixAI 不适合；其他候选也缺少用户图库上的实测。首轮用同一组样本比较发色、发型、眼睛、检索可用性及运行成本，再决定默认方案。

2026-10-04 更新：领域对齐 Q66 改为跟随社区默认 PixAI v0.9、WD SwinV2 v3 作后备，[#6](https://github.com/Yukk1No/kinshoko/issues/6) 只验证其在验收机器上的运行与分级可靠性，不再做多模型准确度比较。见[验收约定](../validation/acceptance.md)。

## 证据与比较规则

- **作者自报**：模型作者给出的评测、配置或成绩。本次未独立复现。
- **同协议作者对照**：同一作者发布的共同评测；仍需核查数据、词表、阈值和统计口径。
- **源码／元数据核查**：通过固定版本的词表、代码和公开文件元数据核查；未据此声称推理已实测成功。
- **本次判断**：针对 Kinshoko 需求的推论或建议，不能当作模型作者的保证。

F1 综合标签的 Precision 和 Recall；Micro 与 Macro 的平均方式不同。F1 不是“有多少张图完全正确”，也不能把不同数据集上的 F1 直接排成总榜。[指标定义](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.f1_score.html)

需要分别看四件事：词表中有没有目标标签、该标签识别是否可靠、多个标签能否形成有用的候选结果，以及画师找到可用参考需要多久。大量角色、作品或作者标签会影响总分，但不直接回答“中分和齐刘海找得准不准”。

## 对领域边界的含义

这十项候选都是图片到标签的分类方案。所核查的公开标签接口不提供“人物 A 有蓝发、人物 B 有短发”这样的实例属性关系。将蓝发与短发组合查询，仍需按图片级标签理解；用户裁出局部再送入识别，属于新的输入分布，需单独评测。

`parted_bangs`（分开的刘海）不应自动当作 `middle_part`（中分）；一般 `bangs` 也不应自动当作齐刘海。中文分类和标签别名由应用组织，但不能通过别名映射制造模型缺少的识别类别。每种词表的实际证据在后文列明。

Kinshoko 的自动标签建议应继续保留人工修正空间。模型名称、权重版本、输出分数、建议来源和人工修改是不同信息；更换模型、阈值或词表时，需要能解释结果变化。本段是研究得到的产品设计建议，具体规格仍待领域访谈确认。

## 十个模型的对照

表中成绩全部为作者自报；**不同系列之间不能直接按 F1 排名**。下载体积使用十进制 MB／GB，指所列发布文件，不包含运行时和配置，更不等于 RAM／VRAM。精确 revision、元数据出处与阈值证据在后文的各组详录中。

| 模型 | 领域与词表 | 公开准确度证据 | 输入 | 本地发布路径与下载体积 |
|---|---|---|---|---|
| [WD SwinV2 v3](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/README.md) | Danbooru；10,861 标签 | Macro-F1 0.4541，P=R 阈值 0.2653 | 448² | 原生 ONNX [467.46 MB](https://huggingface.co/api/models/SmilingWolf/wd-swinv2-tagger-v3?blobs=true)；timm／Safetensors |
| [WD ViT v3](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/blob/7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f/README.md) | 同一 WD v3 数据说明和词表 | Macro-F1 0.4402，阈值 0.2614 | 448² | 原生 ONNX [378.54 MB](https://huggingface.co/api/models/SmilingWolf/wd-vit-tagger-v3?blobs=true)；timm／Safetensors |
| [WD ConvNeXt v3](https://huggingface.co/SmilingWolf/wd-convnext-tagger-v3/blob/d39e46de298d27340111b64965e20b8185c407e6/README.md) | 同一 WD v3 数据说明和词表 | Macro-F1 0.4419，阈值 0.2682 | 448² | 原生 ONNX [394.99 MB](https://huggingface.co/api/models/SmilingWolf/wd-convnext-tagger-v3?blobs=true)；timm／Safetensors |
| [WD ViT Large v3](https://huggingface.co/SmilingWolf/wd-vit-large-tagger-v3/blob/ae469aa2e4706a3af08d3673cf73a11d1add314c/README.md) | 同一 WD v3 数据说明和词表 | Macro-F1 0.4674，阈值 0.2606 | 448² | 原生 ONNX [1,260.65 MB](https://huggingface.co/api/models/SmilingWolf/wd-vit-large-tagger-v3?blobs=true)；timm／Safetensors |
| [WD EVA02 Large v3](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/blob/b25b82a03f7282e41aa2f257a52c7583b710bd1c/README.md) | 同一 WD v3 数据说明和词表 | Macro-F1 0.4772，阈值 0.5296 | 448² | 原生 ONNX [1,260.44 MB](https://huggingface.co/api/models/SmilingWolf/wd-eva02-large-tagger-v3?blobs=true)；timm／Safetensors |
| [WD EVA02 2026 Canary](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/README.md) | 更新至 2026-05 的 Danbooru；16,473 标签 | F1 0.5416，阈值 0.6094；平均方式未公开 | 448² | 原库 Safetensors [1,283.81 MB](https://huggingface.co/api/models/ashen-sensored/wd-eva02-tagger-2026-canary?blobs=true)；应用侧另转 ONNX |
| [animetimm EVA02 dbv4-full](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full) | Danbooru V4 full；12,476 标签 | 整体 micro 0.693／macro 0.569；general macro 0.445 @ 0.4 | 448² | 原生 ONNX [1,268.83 MB](https://huggingface.co/api/models/animetimm/eva02_large_patch14_448.dbv4-full?blobs=true)；Torch／timm |
| [JoyTag](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/README.md) | Danbooru 2021＋辅助照片域；5,813 标签 | 作者称平均 F1 0.578 @ 0.4；有逐标签结果，生成阈值未标明 | 448² | 原生 ONNX [366.12 MB](https://huggingface.co/api/models/fancyfeast/joytag?blobs=true)；Torch，有 CPU／CUDA 示例 |
| [Camie v2](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/README.md) | Danbooru 2024；70,527 标签，含 general、角色、作品、作者等 | micro 0.6735 @ 0.614286；macro 0.5062 @ 0.491837，两个方案 | 512² | 原生 ONNX [788.98 MB](https://huggingface.co/api/models/Camais03/camie-tagger-v2/revision/7d40c1b85b86ab4f607b2caf26b1b50c99db743e?blobs=true)；Safetensors 572.15 MB |
| [PixAI v0.9](https://huggingface.co/pixai-labs/pixai-tagger-v0.9) | Danbooru 2025-01；认可转换词表 13,461 项，偏角色覆盖和召回 | 全标签 micro 约 0.60；角色 F1 0.865 @ 0.75；目标发型分项未知 | 448² | 作者 `.pth` [1,271.55 MB](https://huggingface.co/api/models/pixai-labs/pixai-tagger-v0.9/revision/fe57a3cec0cc2094c325924dc675dd63adff33cc?blobs=true)；认可的 DeepGHS ONNX [1,271.37 MB](https://huggingface.co/api/models/deepghs/pixai-tagger-v0.9-onnx/revision/d8cf666911a2c3d10d586d7823259192313c7eb7?blobs=true) |

下载体积的一手依据为各固定仓库的 API 文件元数据，详录中的参数／文件表逐项给出链接。上表“原生 ONNX”指模型作者原库发布；PixAI 的 ONNX 是作者认可的转换发布者文件，Canary 的 Curator 路线则在用户本机转换。

### 哪些准确度比较可以成立

WD v3 五项的作者模型卡采用相同数据构造、相同词表及 Macro-F1 名称，可以作为**同系列初筛**：EVA02 Large > ViT Large > SwinV2 > ConvNeXt > ViT。各自阈值不同，最后的 P=R 搜索程序和类别 mask 未完整核实；缺少置信区间，不能把该顺序升级为目标图库排名。

Canary 改变了数据时间、验证划分和词表，F1 的平均方式也未说明。Camie、animetimm、JoyTag 的评测集和类别不同。PixAI 的角色 F1 是角色识别成绩。它们与 WD 的数字不应混成一张总榜。

Camie 的原始 JSON 能区分两个阈值方案：其总体 micro 最优方案下，general micro 为 0.6641、macro 为 0.2740；总体 macro 最优方案下，general micro 为 0.6023、macro 为 0.3458。**70,527 个标签和更高的总体数字，不等于更好的发型识别。**[固定评测 JSON](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/full_validation_results.json)

### 与画师当前需求直接相关的词表

“有”表示精确名称存在；“未核实”表示当前证据不足。没有用相近名称代替目标标签。

| 模型组 | 常见发色／发长 | `blunt_bangs`（齐刘海候选） | `parted_bangs`（分开的刘海） | `middle_part`（中分） | 眼睛属性 |
|---|---|---|---|---|---|
| WD v3 五项 | 有 | 有 | 有 | **无** | 有颜色、状态及部分形态标签 |
| Canary | 有 | 有 | 有 | **有** | 有 |
| animetimm EVA | 数据卡／演示证实部分常见标签 | 完整词表受门禁，未核实 | 未核实 | 未核实 | 演示证实部分颜色标签 |
| JoyTag | 有 | 有 | 有 | **无** | 有常见颜色标签 |
| Camie v2 | 有 | 有 | 有 | **有** | 有颜色、状态及形态标签 |
| PixAI v0.9 认可 ONNX | 有 | 有 | 有 | **无** | 有颜色、状态及形态标签 |

直接依据：[WD 固定 CSV](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/selected_tags.csv)、[Canary 固定 CSV](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/selected_tags.csv)、[animetimm 数据卡](https://huggingface.co/datasets/animetimm/danbooru-wdtagger-v4-w640-ws-full?not-for-all-audiences=true)、[JoyTag 固定词表](https://huggingface.co/fancyfeast/joytag/blob/6b7f16331a6ccf0fdce37d5a9564715f6e772b22/top_tags.txt)、[Camie 固定元数据](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json)、[PixAI 转换固定 CSV](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/blob/d8cf666911a2c3d10d586d7823259192313c7eb7/selected_tags.csv)。

JoyTag 提供了少见的目标单标签原始结果：蓝发 F1 0.7991、长发 0.8658、齐刘海 0.4887、分开刘海 0.4776。这是作者验证集结果；逐项文件没有阈值记录，不能声称就是 README 推荐的 0.4。完整 Precision／Recall 与正例支持数见详录。[官方逐项结果](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/full-metrics.txt)

### 性能与获取成本

在本次读取的作者资料中，十项模型都缺少足以形成可靠 Windows 排名的统一单图延迟、批量吞吐和峰值 RAM／VRAM 数据。公开的输入尺寸、参数数和文件大小能用于准备部署，不能换算成“每张几毫秒”或“显存只需多少”。具体未知项在详录中逐组说明。

| 事项 | 已核实情况 | 对 Kinshoko 的意义 |
|---|---|---|
| CPU | 各组都有本地代码或 ONNX 接入路径；本次未运行 | 可纳入通用基线，实际速度与兼容性待测 |
| NVIDIA GPU | 多组作者代码有 CUDA 路径；具体实现和 batch 不同 | 可验证批量索引；仍需记录硬件、运行时、精度及绘画软件同时运行时的影响 |
| DirectML／Windows ML | ORT 提供 Windows 路径，当前文档建议新 Windows 项目考虑 Windows ML | 运行时支持不能替代每个模型的算子与数值验证；详见部署章节 |
| 无门禁原库 | WD v3 五项、Canary、JoyTag、Camie | 首次下载相对直接；仍需完整缓存与版本固定才能保证离线启动 |
| 门禁原库 | animetimm EVA、PixAI v0.9 | 原库获取需 HF 登录与接受条件；PixAI 认可的 DeepGHS ONNX 是另一条无门禁发布路径 |
| 当前许可字段 | WD／Canary／JoyTag 为 Apache-2.0；animetimm／Camie 为 GPL-3.0；PixAI 当前权重为 Apache-2.0 | 只是发布者声明；软件、权重和转换器应分别记录，项目许可证仍未选定 |

PixAI 旧官方公告写 MIT，当前模型卡写权重 Apache 2.0；差异在详录保留。当前公开 Demo 已升级到 v1.0，本次读取 v0.9 历史代码，没有将新 Demo 的能力记到旧模型上。

### 接入时应优先检查的差异

- 原生 WD ONNX 为 NHWC、0–255 BGR；timm 路线为 NCHW、归一化输入和外部 sigmoid。它们的契约不同。
- animetimm EVA 与 JoyTag 使用各自的 CLIP 归一化路径；不能沿用 WD 的处理步骤。
- Camie 使用 512² RGB／ImageNet 归一化，输出 refined logits 后再 sigmoid。
- PixAI 认可 ONNX 使用 448² RGB 归一化，`prediction` 已经 sigmoid；重复激活会改变分数。其角色默认阈值文件为 0.85，与模型卡评测用的 0.75 不同。
- Canary 在 Curator 中由本地转换为固定 batch=1 的 ONNX；转换脚本的随机输入 shape 检查不等于与原模型数值对齐或准确度验证。

以上均有固定代码／配置依据，详录给出直接链接。模型文件、词表顺序、预处理、输出名／激活和阈值策略应作为一组记录，防止更新其中一项后结果悄然改变。

## 部署环境与后续验证

以下运行时能力由维护者文档支持；本次没有执行模型推理，后续评估方案尚未执行。

### Windows 本地部署

| 路径 | 已证实的运行时能力 | 对模型选型的含义 |
|---|---|---|
| ONNX Runtime CPU | 官方提供 CPU 发行包及多个语言接口；Windows 构建需要相应 Visual C++ runtime。[安装说明](https://onnxruntime.ai/docs/install/) | 原生 ONNX 可作为 CPU 接入起点。每个具体模型的算子、输入类型、延迟和内存仍须验证。 |
| NVIDIA CUDA | 官方 CUDA EP 支持 NVIDIA GPU，ORT、CUDA 和 cuDNN 的版本须匹配。[CUDA EP](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) | 较大模型有本地加速路径；部署包、驱动环境与版本维护成本需要计入。不能把某 GPU 的吞吐量移用到另一张卡。 |
| DirectML | 支持 DirectX 12 设备；当前文档列出 opset 与算子边界，要求关闭 memory pattern 与并行 execution，同一 session 的 Run 需串行调用。[DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html) | 可覆盖多厂商 Windows GPU，但不能由“ONNX 文件存在”推断某模型完整在 GPU 执行。须核查算子回落、结果一致性及吞吐量。 |
| Windows ML | 当前 ORT 文档将 DirectML 标为持续维护，并将新 Windows 项目指向 Windows ML。[ORT 安装](https://onnxruntime.ai/docs/install/)、[DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html) | 这是应纳入后端调研的新选项，不是已经选定的项目技术栈。 |

Windows ML 的 CPU／DirectML 能力与新硬件执行提供器目录有不同系统要求：后者要求 Windows 11 24H2 或更新。自包含与依赖系统 runtime 两种发行方式也应分开考虑；Microsoft 当前文档给出的自包含 runtime 大小约 41 MB，不含模型权重和可选厂商 EP。[入门与系统要求](https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/get-started)、[发行方式](https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/distributing-your-app)

FP16／INT8 可作为后续优化候选；量化可能改变准确度，性能收益取决于模型与硬件，不能按权重压缩比例承诺加速。转换版须重新验证目标标签和后端兼容性。[ORT 量化文档](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)

Hugging Face gated 模型需要用户通过模型作者的访问条件；自动批准仍涉及向作者共享账户联系信息。词表或文件列表公开，不等于权重可以无账号下载。[HF 门禁说明](https://huggingface.co/docs/hub/models-gated)

### 建议的后续同机评估

以下是评估方案，未执行，也不构成已确认的产品规格。

1. 建立一份画师确认的参考图样本，覆盖单人／多人、头像／全身、遮挡、线稿、厚涂、灰度、复杂光照和局部裁切。校准集与最终评测集分开；相同原图的裁切与近似重复图片不跨两组。
2. 对发色、发长、齐刘海、中分、常见其他发型和眼睛特征标注明确的正例、反例与无法判断项。无法判断不当成反例；从各模型原生标签到这些任务建立可检查的映射。
3. 在同一份样本上报告目标标签的 Precision、Recall、F1 及样本数，并单独记录多人图中属性归属不明。使用统一默认阈值的结果与各模型经校准后的结果分开；不能在最终评测集调阈值后再报告。
4. 加一层实际找图任务：让画师判断前若干候选是否可用，记录查到第一张可用图所需时间与需手工纠错的次数。以此衡量是否改善绘画工作流。
5. 性能记录首次下载与加载、首张图、预热后单张 p50／p95、批量持续吞吐、峰值 RAM／VRAM、CPU／GPU 使用，以及绘画软件同时运行时的影响。分别测纯推理和“读图→预处理→推理→结果保存”的总时长。
6. 记录设备、OS、模型 revision／文件 hash、dtype、输入尺寸、运行时版本、EP、batch size 与线程数。先记录未量化基线，再比较转换版；确认没有静默回落到 CPU。ORT 可输出算子与线程的性能 trace。[官方 profiling 工具](https://onnxruntime.ai/docs/performance/tune-performance/profiling-tools.html)

样本数量、可接受延迟和具体硬件应结合画师的图库与工作习惯设定。本次公开资料研究不填入未做过的本地性能或准确度结果。

## 逐组证据详录

以下保存精确版本、一手资料、评测口径与接入差异，供之后复核和实测。软件／权重许可字段仅转述发布者声明。

### A. WD v3 与 WD EVA02 2026 Canary

#### 版本和可复核入口

下表为本次实际读取的仓库 `main` 快照。API 返回的 SHA 可用于固定模型、配置和词表；生产接入应固定同一快照并核验文件哈希，而不是动态跟踪 `main`。SmilingWolf 的模型卡也建议下游使用 tagged releases。[Swin 卡](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/README.md)

| 精确模型 ID | 本次读取 revision | 官方命名 release | 元数据来源 |
| --- | --- | --- | --- |
| `SmilingWolf/wd-swinv2-tagger-v3` | `627aef95638667ddcaa3ac8ae625e88ea5b02f51` | `v2.0` → `2347d85bfbc496d3c10e0588713e098abb3bdce7` | [模型 API](https://huggingface.co/api/models/SmilingWolf/wd-swinv2-tagger-v3?blobs=true)、[refs API](https://huggingface.co/api/models/SmilingWolf/wd-swinv2-tagger-v3/refs) |
| `SmilingWolf/wd-vit-tagger-v3` | `7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f` | `v2.0` → `1a42a2f7fa13f005a8a040d0a68e16523865f562` | [模型 API](https://huggingface.co/api/models/SmilingWolf/wd-vit-tagger-v3?blobs=true)、[refs API](https://huggingface.co/api/models/SmilingWolf/wd-vit-tagger-v3/refs) |
| `SmilingWolf/wd-convnext-tagger-v3` | `d39e46de298d27340111b64965e20b8185c407e6` | `v2.0` → `8295ce1a50da2921c8a48949a60e9abfcf5a6128` | [模型 API](https://huggingface.co/api/models/SmilingWolf/wd-convnext-tagger-v3?blobs=true)、[refs API](https://huggingface.co/api/models/SmilingWolf/wd-convnext-tagger-v3/refs) |
| `SmilingWolf/wd-vit-large-tagger-v3` | `ae469aa2e4706a3af08d3673cf73a11d1add314c` | `v1.0` → `f733eccbdccf739356c05cc1939849bfbd059d54` | [模型 API](https://huggingface.co/api/models/SmilingWolf/wd-vit-large-tagger-v3?blobs=true)、[refs API](https://huggingface.co/api/models/SmilingWolf/wd-vit-large-tagger-v3/refs) |
| `SmilingWolf/wd-eva02-large-tagger-v3` | `b25b82a03f7282e41aa2f257a52c7583b710bd1c` | `v1.0` → `c5303bb7139430db980e4c680a778fe79d72b541` | [模型 API](https://huggingface.co/api/models/SmilingWolf/wd-eva02-large-tagger-v3?blobs=true)、[refs API](https://huggingface.co/api/models/SmilingWolf/wd-eva02-large-tagger-v3/refs) |
| `ashen-sensored/wd-eva02-tagger-2026-canary` | `c45a59a3f17c0ca6066072b1c213e0c12a90e242` | API 未列出 release tag | [模型 API](https://huggingface.co/api/models/ashen-sensored/wd-eva02-tagger-2026-canary?blobs=true)、[refs API](https://huggingface.co/api/models/ashen-sensored/wd-eva02-tagger-2026-canary/refs) |

注意：仓库名的 `v3` 指 Dataset v3 系列，Swin/ViT/ConvNeXt 的最新模型 release 又名 `v2.0`；不要把两个版本层级混为一个。[Swin 版本说明](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/README.md)

#### Domain、训练分布与标签覆盖

WD v3 五个变体的模型卡声明相同的数据构造：Danbooru 图片截至 ID `7,220,105`，内容截至 `2024-02-28`；训练取 ID 尾数 `0000–0899`，验证取 `0950–0999`；过滤一般标签不足 `10` 个的图片，以及出现图片不足 `600` 张的标签。因此，其公开验证针对 Danbooru 标注体系，不能推定写实照片、未完成线稿、极小裁切或画师私有图库的效果。[WD v3 数据说明](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/README.md)

Canary 基于 WD EVA02-Large v3，模型卡声明训练数据截止 `2026-05-18` / Danbooru ID `11,403,645`，训练图片 ID 高于 `7,220,105` 且尾数 `0000–0899`，验证尾数 `0900–0949`，并进行逐标签 operating-point recentering。它更贴近更新内容，但作者没有公开这些处理对旧图/旧标签保持率的独立评测。[Canary 数据说明](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/README.md)

本次解析固定 revision 的 CSV，得到下列**词表文本统计**：

| 模型系列 | 全部输出 | general（category 0） | character（category 4） | rating（category 9） | 证据 |
| --- | ---: | ---: | ---: | ---: | --- |
| WD v3 五个变体 | 10,861 | 8,106 | 2,751 | 4 | [固定词表](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/selected_tags.csv)；5 个仓库的 CSV Git blobId 都是 `a2a653a5c89c8e387765eb1de9cfd2aedc92ee8d`，见上方模型 APIs |
| Canary | 16,473 | 11,601 | 4,868 | 4 | [固定词表](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/selected_tags.csv)；CSV 文本分组计数 |

词表里与当前用户工作流直接相关的覆盖如下。每一行均逐项检查上述两个固定词表；“有”表示能够输出该名称，没有逐标签准确度含义。

| 需求 | WD v3 | Canary | 产品解释 |
| --- | --- | --- | --- |
| 发色 | 有 `blue_hair` / `black_hair` / `blonde_hair` 等 | 有 | 可以映射中文显示名与别名；具体色调粒度取决于词表 |
| 发长 | 有 `short_hair` / `medium_hair` / `long_hair` / `very_long_hair` | 有 | 词表可支持短/中/长发条件 |
| 齐刘海 | 有 `blunt_bangs` | 有 | 需要向用户说明中文分类所对应的具体视觉含义 |
| 分开的刘海 | 有 `parted_bangs` / `swept_bangs` / `asymmetrical_bangs` | 有 | `parted_bangs` 不能未经校验直接当成精确“中分”别名 |
| 精确中分 | **没有 `middle_part`**；也没有 `center_part` | **有 `middle_part`**；没有 `center_part` | Canary 的 `middle_part` 词表 `count` 字段为 `862`；不是该标签的实际训练样本数保证，也不是准确度 |
| 一般刘海总类 | 没有单独的 `bangs` | 没有单独的 `bangs` | 可以由应用组织上位分类，但需确定语义规则 |
| 眼睛 | 有 `blue_eyes` / `red_eyes` / `heterochromia` / `closed_eyes` / `half-closed_eyes` / `eyelashes` / `eyeliner` / `tareme` / `tsurime` | 有 | 能力覆盖名称不等于对眼睛局部造型的可靠识别 |
| 人物数量与身份 | 有一般标签 `1girl` / `2girls` / `1boy`，另有 character 类 | 有，character 词表更大 | 人物数量、角色身份与人物实例属性绑定是不同问题 |

来源：[WD v3 CSV](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/selected_tags.csv)、[Canary CSV](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/selected_tags.csv)。

迁移时不能仅在旧词表末尾追加新标签。Canary 卡片声称新增 `5,999` 个标签；本次按字符串名称比较两个 CSV，实际差集为新增 `5,997`、移除 `385`、保留 `10,476`。可能涉及重命名或不同统计基线，原因未被公开材料解释；应以对应模型的完整 CSV 行顺序为准。[卡片声明](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/README.md)、[两份 CSV](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/selected_tags.csv)

#### 作者自报准确度与比较限制

这些是模型作者报告的验证值，**不是本次实测，也不是“多少比例的图片被正确识别”**。

| 模型 | 模型卡所指版本 | 作者 P=R 阈值 | 作者 F1 | 平均方式与来源 |
| --- | --- | ---: | ---: | --- |
| WD SwinV2 v3 | Model `v2.0` / Dataset v3 | 0.2653 | 0.4541 | Macro-F1；[模型卡](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/README.md) |
| WD ViT v3 | Model `v2.0` / Dataset v3 | 0.2614 | 0.4402 | Macro-F1；[模型卡](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/blob/7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f/README.md) |
| WD ConvNeXt v3 | Model `v2.0` / Dataset v3 | 0.2682 | 0.4419 | Macro-F1；[模型卡](https://huggingface.co/SmilingWolf/wd-convnext-tagger-v3/blob/d39e46de298d27340111b64965e20b8185c407e6/README.md) |
| WD ViT-Large v3 | Model `v1.0` / Dataset v3 | 0.2606 | 0.4674 | Macro-F1；[模型卡](https://huggingface.co/SmilingWolf/wd-vit-large-tagger-v3/blob/ae469aa2e4706a3af08d3673cf73a11d1add314c/README.md) |
| WD EVA02-Large v3 | Model `v1.0` / Dataset v3 | 0.5296 | 0.4772 | Macro-F1；[模型卡](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/blob/b25b82a03f7282e41aa2f257a52c7583b710bd1c/README.md) |
| WD EVA02 2026 Canary | Canary；未列 release tag | 0.6094 | 0.5416 | **模型卡未说明 macro / micro / 其他平均方式**；[模型卡](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/README.md) |

作者 JAX-CV 当前评测代码在 macro 模式下对每个标签累计 TP/FP/FN，再平均 `2TP/(2TP+FP+FN)`；若某标签分母为零，该实现将其 F1 设为 `1`。micro 模式则把混淆计数先聚合到全体标签。训练 loop 用完整 `num_classes`，没有看到 general-only mask。[固定版本 ConfusionMatrix](https://github.com/SmilingWolf/JAX-CV/blob/9e9c9ff956133614257826c1f04a755aa994ac17/Metrics/ConfusionMatrix.py)、[训练 loop](https://github.com/SmilingWolf/JAX-CV/blob/9e9c9ff956133614257826c1f04a755aa994ac17/training_loop.py)

但当前训练 loop 的固定阈值 `0.4` 不是模型卡报告的各自阈值，本次没有找到模型卡最终 P=R 搜索的完整可复现程序。因此：能确定 WD v3 的卡片指标名为 Macro-F1，不能进一步证明最终报告是否使用完整 rating/general/character 三类、如何筛零样本类，以及 P=R 是 macro 还是 micro 的 P/R 相等。P=R 按卡片字面表示 precision 与 recall 相等的 operating point，不应擅自解释为最优 Macro-F1 点。[同一训练 loop](https://github.com/SmilingWolf/JAX-CV/blob/9e9c9ff956133614257826c1f04a755aa994ac17/training_loop.py)、[EVA 卡](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/blob/b25b82a03f7282e41aa2f257a52c7583b710bd1c/README.md)

比较边界：WD v3 五个变体有相同数据说明、相同词表和一致指标命名，允许把作者自报值用于同系列初筛；缺少置信区间与逐标签结果，不能推定微小差异在用户图库上仍成立。Canary 与它们的标签全集、验证分割、时间分布均不同，且 F1 平均方式未公开，不能拿它的 `0.5416` 直接排名在 `0.4772` 之前。与 Camie、JoyTag、animetimm、PixAI 的跨系列比较也必须使用统一样本、标签映射、阈值选择和指标。

#### 架构、输入与文件体积

下表参数数来自作者仓库 API 对 Safetensors 的元数据；输入和架构来自各仓库固定 `config.json`，不是由文件名猜测。Safetensors dtype 元数据均为 F32。下载大小按十进制 **MB = 1,000,000 bytes** 计算并四舍五入；文件大小不等于运行内存或峰值显存。

| 模型 | 架构 / 关键覆盖参数 | 输入 | 参数数 | 作者原库 ONNX | 作者原库 Safetensors | 来源 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| SwinV2 v3 | `swinv2_base_window8_256`，配置覆盖 window=14 / img=448 | 448 × 448 | 98,026,341 | 467.46 MB | 392.15 MB | [config](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/config.json)、[API](https://huggingface.co/api/models/SmilingWolf/wd-swinv2-tagger-v3?blobs=true) |
| ViT v3 | `vit_base_patch16_224`，配置覆盖 img=448、无 class token、avg pool | 448 × 448 | 94,600,813 | 378.54 MB | 378.42 MB | [config](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/blob/7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f/config.json)、[API](https://huggingface.co/api/models/SmilingWolf/wd-vit-tagger-v3?blobs=true) |
| ConvNeXt v3 | `convnext_base` | 448 × 448 | 98,698,989 | 394.99 MB | 394.83 MB | [config](https://huggingface.co/SmilingWolf/wd-convnext-tagger-v3/blob/d39e46de298d27340111b64965e20b8185c407e6/config.json)、[API](https://huggingface.co/api/models/SmilingWolf/wd-convnext-tagger-v3?blobs=true) |
| ViT-Large v3 | `vit_large_patch16_224`，实际配置覆盖 patch=14 / img=448，无 class token、avg pool | 448 × 448 | 315,095,661 | 1,260.65 MB | 1,260.41 MB | [config](https://huggingface.co/SmilingWolf/wd-vit-large-tagger-v3/blob/ae469aa2e4706a3af08d3673cf73a11d1add314c/config.json)、[API](https://huggingface.co/api/models/SmilingWolf/wd-vit-large-tagger-v3?blobs=true) |
| EVA02-Large v3 | `eva02_large_patch14_448`，avg pool | 448 × 448 | 315,187,757 | 1,260.44 MB | 1,260.80 MB | [config](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/blob/b25b82a03f7282e41aa2f257a52c7583b710bd1c/config.json)、[API](https://huggingface.co/api/models/SmilingWolf/wd-eva02-large-tagger-v3?blobs=true) |
| EVA02 2026 Canary | `eva02_large_patch14_448`，avg pool、扩展输出头 | 448 × 448 | 320,940,057 | **原库未列出 ONNX** | 1,283.81 MB | [config](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/config.json)、[API](https://huggingface.co/api/models/ashen-sensored/wd-eva02-tagger-2026-canary?blobs=true)、[export.json](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/export.json) |

以上原库快照没有单独发布命名为 FP16 的 artifact；Safetensors 的 F32 有 API 明确依据。未经下载解析 ONNX 图，本次不把浮点输入类型自动当成全部权重精度声明。模型树中的第三方 quantization 不等于作者发布的量化模型，也没有在本次对其准确度背书。

#### 部署方式与具体接入风险

##### WD v3 的原生 ONNX 路线

作者提供 `model.onnx` + `selected_tags.csv`，模型卡要求 `onnxruntime >= 1.17.0`，ONNX batch 维度不再固定为单图。官方 Gradio demo 使用 `onnxruntime.InferenceSession(model_path)`，未显式选择 CUDA 或 DirectML provider；其依赖是 `onnxruntime`，不是 `onnxruntime-gpu`。这提供了 CPU 接入代码证据，但没有证明各硬件 provider 的完整算子覆盖或性能。[EVA 模型卡](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/blob/b25b82a03f7282e41aa2f257a52c7583b710bd1c/README.md)、[固定 demo](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/app.py)、[demo 依赖](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/requirements.txt)

官方 demo 的预处理是：透明区域合成到白底；保持长宽比，白色补方形；bicubic 缩放；NHWC、float32、RGB 转 BGR，像素保留 `0–255`。输出直接按 CSV 行顺序解释为分数，再分别筛选 general 与 character。[同一 app.py](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/app.py)

该 demo 的一般标签默认阈值 `0.35`、角色默认 `0.85`，另可用 MCut。它们与模型卡的 P=R 验证阈值不同，不能把 demo 默认值说成每个模型的最优默认值，尤其 EVA 的分数 operating point 与较小变体不同。[同一 app.py](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/app.py)

##### timm / PyTorch 路线

5 个 WD v3 原库都有 timm config 与 Safetensors；作者卡片给出 `timm.create_model("hf_hub:<repo>", pretrained=True)`。作者链接的 neggles 示例源码选择可用 CUDA，否则 CPU；其命令行 registry 只列 SwinV2/ConvNeXt/ViT 三个较小模型，不能声称这个 CLI 无改动覆盖 Large/Canary。[EVA 卡](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/blob/b25b82a03f7282e41aa2f257a52c7583b710bd1c/README.md)、[固定 timm 示例](https://github.com/neggles/wdv3-timm/blob/2f49e85ea3f5561e974a00d1756e357539b66acd/wdv3_timm.py)

timm 路线为 NCHW，按配置 mean/std `0.5` 归一化，转换 BGR，模型给出 logits 后由示例外部 sigmoid。**它与原生 WD ONNX 的输入/输出契约不同**；共享适配器时必须将预处理与输出激活绑定到具体 artifact。示例每次还把模型在 CPU/GPU 间搬动，不宜将其作为持续批量索引性能的最优实现。[timm 示例](https://github.com/neggles/wdv3-timm/blob/2f49e85ea3f5561e974a00d1756e357539b66acd/wdv3_timm.py)

##### Canary 的原生路线与 Curator 的应用侧转换

Canary 作者原库是 timm + Safetensors；卡片展示本地构建 `eva02_large_patch14_448` 并加载 state dict，没有原生 ONNX。[模型卡](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/README.md)、[原库文件树](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/tree/c45a59a3f17c0ca6066072b1c213e0c12a90e242)

Project Curator 的固定清单已将它列为 optional，下载的是原作者 Safetensors/CSV/config，随后在本地转换 ONNX。因此，**原库没有 ONNX 不表示其他软件不能接入**。[Curator 清单](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/model_manifest.json)

该应用自己的转换脚本使用 opset `17`，导出输入 `pixel_values [1,3,448,448]`、输出 `logits [1,16473]`；没有指定动态 batch，且生成不同于官方 WD 原生 ONNX 的输入契约。脚本 CPU ORT 验证使用随机输入检查 shape 和能否运行，未做 PyTorch/ONNX 数值误差比较或真实标签准确度比较。这是源码能力证据，本次没有运行转换或独立复现。[固定 converter](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/scripts/convert_to_onnx.py)

##### 本地、离线与首次下载

6 个仓库本次模型 API 都返回 `private=false`、`gated=false`，文本文件无鉴权可读；未发现需要签署门禁协议。原生 WD demo 首次通过 `hf_hub_download` 取权重与词表，加载后在本地推理；Canary 卡片的手动 Safetensors 加载也可只用本地文件。由这些接口可以推断：准备完整 artifact 和依赖后，可以实现本地离线推理，不必把图片上传第三方。但产品应明确处理首次下载、缓存、哈希、离线缺文件与下载失败，不能由“使用本地模型”推定 demo 首次启动也离线可用。[上方 6 个模型 APIs](https://huggingface.co/api/models/ashen-sensored/wd-eva02-tagger-2026-canary?blobs=true)、[官方 demo](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/app.py)、[Canary 本地加载示例](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/README.md)

#### 性能证据表

| 项目 | WD v3 五个变体 | Canary | 当前证据等级 |
| --- | --- | --- | --- |
| CPU 本地推理入口 | 官方 ONNX demo；作者链接的 timm 示例 | 作者 timm 加载；Curator converter 带 CPU shape 检查 | 源码路径存在；本次未运行 |
| NVIDIA CUDA | 作者链接的 timm 示例有自动 CUDA 选择；Large 的卡片支持 timm | 同一 timm 家族，具体 CUDA 行为需验证 | 小模型示例源码有路径；不是全型号同硬件实测 |
| DirectML / Windows GPU | 原生 ONNX 可尝试接 ORT provider；作者 demo 没有 DML 路径 | 需额外导出，Curator 已有应用侧路线 | 通用 runtime 能力与应用源码不能替代模型数值/算子/性能验证 |
| 批量 | 卡片明确 ONNX 非固定 batch | 原库 timm 可设计批量；Curator 固定 converter batch=1 | v3 原生支持声明；Canary 的具体转换不能自动继承 |
| FPS / 每图耗时 / 万图总时长 | **未找到作者提供的硬件、batch、后端、精度条件齐全的基准** | 同样未知 | 不造数字；不引用他人不同实现的速度来排名 |
| 峰值 RAM / VRAM、与绘画软件同时运行的占用 | **未知** | **未知** | 下载大小和参数量不是运行峰值 |
| FP16 / INT8 提速及标签损失 | 原库本次快照未发布独立 FP16/INT8 artifact 的验证 | 原库同样没有 | 转换/量化需数值与领域标签回归评测 |

证据：[WD 卡片](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/blob/627aef95638667ddcaa3ac8ae625e88ea5b02f51/README.md)、[timm 示例](https://github.com/neggles/wdv3-timm/blob/2f49e85ea3f5561e974a00d1756e357539b66acd/wdv3_timm.py)、[WD demo](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/app.py)、[Curator converter](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/scripts/convert_to_onnx.py)。

#### 许可声明与开放项

5 个 SmilingWolf 模型卡都声明 `apache-2.0`；Canary 卡片也声明 `apache-2.0`，原库附有 Apache License 文本。本段仅记录作者声明，不对训练图片权利或 Kinshoko 发布义务作法律判断。[Swin](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3)、[ViT](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3)、[ConvNeXt](https://huggingface.co/SmilingWolf/wd-convnext-tagger-v3)、[ViT-Large](https://huggingface.co/SmilingWolf/wd-vit-large-tagger-v3)、[EVA02-Large](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3)、[Canary LICENSE](https://huggingface.co/ashen-sensored/wd-eva02-tagger-2026-canary/blob/c45a59a3f17c0ca6066072b1c213e0c12a90e242/LICENSE)

选型前仍需统一实测：用户最常找的发色/发长/刘海/眼睛标签的 precision、recall 与搜索候选命中；整图与裁切输入的差异；多人图组合条件的假阳性；冷启动/热启动、后台索引吞吐、峰值 RAM/VRAM、绘画软件同时运行的影响；各 provider 和精度 artifact 的数值一致性。WD v3、Canary 及其他系列必须先做词表对齐，再谈跨模型排名。

#### 一手资料快照清单

- 模型卡、配置、CSV 与 artifact 元数据：上方 6 个 exact ID 和完整 SHA；日期 2026-10-01。
- SmilingWolf 官方 ONNX demo：Space revision `fbd35b187d6e8cb8a00c529d52999f82d6b5193b`，[文件](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/app.py)。
- 模型作者链接的 timm 示例：neggles/wdv3-timm revision `2f49e85ea3f5561e974a00d1756e357539b66acd`，[文件](https://github.com/neggles/wdv3-timm/blob/2f49e85ea3f5561e974a00d1756e357539b66acd/wdv3_timm.py)。
- SmilingWolf 评测实现：JAX-CV revision `9e9c9ff956133614257826c1f04a755aa994ac17`，[指标实现](https://github.com/SmilingWolf/JAX-CV/blob/9e9c9ff956133614257826c1f04a755aa994ac17/Metrics/ConfusionMatrix.py)。
- Project Curator 接入：revision `f98f0b5c1941185ba781cb51963fefe023d42c42`，[清单](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/model_manifest.json)、[应用侧转换](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/scripts/convert_to_onnx.py)。


### B. animetimm EVA02 dbv4-full 与 JoyTag

#### 固定版本与结论

| 对象 | 本次固定 revision |
| --- | --- |
| animetimm/eva02_large_patch14_448.dbv4-full | `7f11ec9fdb54dfbfd7cd7fad2ecc452a25b57acb`（[官方 API](https://huggingface.co/api/models/animetimm/eva02_large_patch14_448.dbv4-full?blobs=true)） |
| animetimm/danbooru-wdtagger-v4-w640-ws-full | `47c6dd537119785c8dc4eb8c0fb647aa9264f2ca`（[官方 API](https://huggingface.co/api/datasets/animetimm/danbooru-wdtagger-v4-w640-ws-full)） |
| fancyfeast/joytag | `6b7f16331a6ccf0fdce37d5a9564715f6e772b22`（[官方 API](https://huggingface.co/api/models/fancyfeast/joytag?blobs=true)） |
| fpgaminer/joytag 代码及评测 | `ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb`（[固定代码](https://github.com/fpgaminer/joytag/tree/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb)） |
| JoyTag 作者 CPU 演示 | `2ef0e06691f5c2e0e8d7903f5bd4b5c46b4b87f9`（[官方 Space API](https://huggingface.co/api/spaces/fancyfeast/joytag)） |

EVA 的方向是 Danbooru 二次元多标签分类，词表较大，已有 ONNX 和逐标签阈值；当前下载有 Hugging Face 账号门禁。JoyTag 权重和词表无需门禁，体积较小，作者明确扩展到照片域，但其公开逐标签结果显示，细刘海造型比一般发色、发长困难。两者都输出图片级标签；现有证据不包含人物框或“某个眼睛属于某个人”的属性关联。[EVA 模型卡](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full)、[JoyTag 推理代码](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/Models.py)

#### 领域、结构和文件

| 项目 | EVA02 dbv4-full | JoyTag |
| --- | --- | --- |
| 训练域 | Danbooru WDTagger V4 full；数据卡列出训练 5,321,713、验证 296,957、测试 295,926 张。[数据卡](https://huggingface.co/datasets/animetimm/danbooru-wdtagger-v4-w640-ws-full?not-for-all-audiences=true) | Danbooru 2021 加作者人工标注的辅助集，以扩展照片等域；辅助集精确大小在所查说明中未披露。作者所说 660M 是训练累计看过的样本数，不能当作独立训练图片量。[作者说明](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/README.md) |
| 架构、输入 | EVA02 Large、patch 14；训练及测试输入均 448×448。[模型卡](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full) | ViT-B/16，CNN stem 与 GAP head；448×448；配置为 12 层、宽度 768。[配置](https://huggingface.co/fancyfeast/joytag/blob/6b7f16331a6ccf0fdce37d5a9564715f6e772b22/config.json)、[作者说明](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/README.md) |
| 参数、权重精度 | 316,843,132，safetensors 为 F32。[官方 API](https://huggingface.co/api/models/animetimm/eva02_large_patch14_448.dbv4-full?blobs=true) | 91,498,430，safetensors 为 F32。[官方 API](https://huggingface.co/api/models/fancyfeast/joytag?blobs=true) |
| ONNX 磁盘字节数 | 1,268,832,518 bytes；约 1.269 GB，十进制。[官方 API](https://huggingface.co/api/models/animetimm/eva02_large_patch14_448.dbv4-full?blobs=true) | 366,116,154 bytes；约 366.116 MB，十进制。[官方 API](https://huggingface.co/api/models/fancyfeast/joytag?blobs=true) |
| safetensors 磁盘字节数 | 1,267,417,504 bytes。[官方 API](https://huggingface.co/api/models/animetimm/eva02_large_patch14_448.dbv4-full?blobs=true) | 366,011,736 bytes。[官方 API](https://huggingface.co/api/models/fancyfeast/joytag?blobs=true) |
| 词表 | 12,476：一般 9,225、人物 3,247、评级 4。[模型卡](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full) | 5,813，固定文本词表；未提供与 EVA 相同的分类字段。[配置](https://huggingface.co/fancyfeast/joytag/blob/6b7f16331a6ccf0fdce37d5a9564715f6e772b22/config.json)、[词表](https://huggingface.co/fancyfeast/joytag/blob/6b7f16331a6ccf0fdce37d5a9564715f6e772b22/top_tags.txt) |

F32 上述证据来自 safetensors 元数据，ONNX 内部所有张量的类型未通过读取大文件核实；不能据此承诺所有发布格式均为 F32，也未核实作者发布的 FP16/INT8 版本。

##### 对画师检索的实际词表检查

| 标签 | EVA 本次公开证据 | JoyTag 固定词表 |
| --- | --- | --- |
| `blue_hair`、`long_hair`、`short_hair`、`blue_eyes` | 数据卡公开选中标签示例；模型样例另外明确输出 `short_hair`、`brown_hair`、`purple_eyes` | 均存在 |
| `bangs`、`blunt_bangs`、`parted_bangs`、`hime_cut` | 完整 `selected_tags.csv` 文件预览返回 401；本次未获下载授权，未核实这几个精确项 | 均存在 |
| `middle_part`、`no_bangs`、`silver_hair` | 未核实 | 不存在 |

来源：[EVA 数据卡](https://huggingface.co/datasets/animetimm/danbooru-wdtagger-v4-w640-ws-full?not-for-all-audiences=true)、[EVA 模型卡的推理样例](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full)、[JoyTag 词表](https://huggingface.co/fancyfeast/joytag/blob/6b7f16331a6ccf0fdce37d5a9564715f6e772b22/top_tags.txt)。这里没有把 `parted_bangs` 当作 `middle_part` 的等义标签，也没有把一般 `bangs` 当作齐刘海。自定义中文检索标签能补足词表组织，但不能制造模型没有的识别能力。

#### 准确度：作者成绩与同协议成绩分开

EVA 模型卡报告测试集整体 Macro F1 **0.569**、Micro F1 **0.693**，统一阈值 **0.40**；一般标签 Macro F1 **0.445**，人物标签 Macro F1 **0.921**，亦为 **0.40**。这说明总分会受人物标签影响；发色、发型的产品判断不能只看整体 F1。作者建议一般标签阈值 **0.39**，此时一般标签 Micro F1 **0.681**。一般标签逐标签最佳阈值 Macro F1 **0.480** 是另一口径，不是默认统一阈值成绩。[EVA 模型卡的结果及阈值表](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full)

JoyTag 作者宣称平均 F1 **0.578**、阈值 **0.4**，验证集 **32,768** 张，并称用 pHash 排除训练重复。没有本次全部候选在同一评测集上的结果，不能与 EVA 的整体分数直接排名。[作者说明](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/README.md)

JoyTag 作者另提供 Validation Arena：在同一组 **32,768** 张较新 Danbooru 图上，取共同且满足频次筛选的 **3,993** 个标签，按标签平均，JoyTag F1 **0.4179**，旧 WD `wd-v1-4-vit-tagger-v2` F1 **0.4241**；阈值分别 **0.4** 与 **0.3537**。这是作者发布的同协议比较，**不是独立评测，也没有比较当前 WD v3、animetimm EVA 或 Camie**。作者只说这些较新图片不太可能被训练使用，并不等于完整证明无训练污染。[Arena 说明](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/validation-arena/README.md)、[验证代码](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/validation-arena/validate.py)

##### JoyTag 官方逐标签证据

以下来自官方 `full-metrics.txt`，支持数是文件中 **TP+FN** 的算术计算，不是标题里的全局 `cnt`。验证集总数为 **32,768**。[逐项原始数据](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/full-metrics.txt)、[验证集说明](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/README.md)

| 标签 | Precision | Recall | F1 | 验证正例支持数 TP+FN |
| --- | ---: | ---: | ---: | ---: |
| `blue_hair` | 0.7272 | 0.8867 | 0.7991 | 3,064 |
| `black_hair` | 0.7173 | 0.9058 | 0.8006 | 5,540 |
| `short_hair` | 0.6388 | 0.8992 | 0.7469 | 8,818 |
| `long_hair` | 0.7908 | 0.9566 | 0.8658 | 16,676 |
| `bangs` | 0.5457 | 0.7416 | 0.6287 | 7,218 |
| `blunt_bangs` | 0.4304 | 0.5652 | 0.4887 | 897 |
| `parted_bangs` | 0.4935 | 0.4626 | 0.4776 | 495 |
| `hime_cut` | 0.3478 | 0.3636 | 0.3556 | 88 |
| `blue_eyes` | 0.7493 | 0.9085 | 0.8212 | 6,874 |
| `purple_eyes` | 0.6746 | 0.8409 | 0.7487 | 2,848 |

**逐项文件没有记录生成阈值。** README 总分及推荐推理阈值为 **0.4**，但仓库训练验证代码使用 **>0.5**；没有足够证据把本表每个值都认定为 **0.4**。应把这个可复现性缺口保留在比较中。[训练验证代码](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/training/train/Train.py)

对 Kinshoko 的推断：上述细刘海标签精度/召回都偏弱，不能用“词表里存在”替代“适合稳定检索”。这只反映作者验证集；用户图库中，局部眼睛、铅笔线稿、遮挡和多人图仍须另测。

#### 部署、预处理和性能

EVA 作者提供 `timm+torch` 和 `dghs-imgutils` ONNX 两条本地路径。后者需模型、词表、预处理、分类和阈值配置；作者封装会调用 HF 下载，并接受 token。当前仓库公开显示需登录接受联系方式共享条件，文件预览亦返回 401。本次没有接受条件。权重及配置取得后，可设计读取本地文件的离线推理；这是集成推断，不等于作者封装默认启动完全不访问网络。[模型卡](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full)、[ONNX 封装说明](https://dghs-imgutils.deepghs.org/main/api_doc/generic/multilabel_timm.html)

JoyTag 官方 CUDA 示例从本地目录读取权重与词表；现行作者 Space 代码另有 CPU autocast 路径，其官方 API 在访问时显示 `cpu-basic`、`RUNNING`。这证明作者提供 CPU 部署路径，不是本次运行验证，也不提供 Windows CPU 延迟数字。Space 启动调用 `snapshot_download`；改为已经下载的本地目录才符合确定的离线启动需求。[作者本地 CUDA 示例](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/README.md)、[作者 CPU 演示代码](https://huggingface.co/spaces/fancyfeast/joytag/blob/2ef0e06691f5c2e0e8d7903f5bd4b5c46b4b87f9/app.py)、[Space API](https://huggingface.co/api/spaces/fancyfeast/joytag)

| 部署/性能问题 | 已知证据 | 对 Kinshoko 尚未验证 |
| --- | --- | --- |
| EVA 预处理 | 模型卡示例先白底补边，配置示例 `PadToSize(512)` 再 bicubic 到 448；使用 CLIP 均值/标准差。[模型卡](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full) | 不应直接沿用 WD 的 BGR/NHWC 预处理；须按导出输入和配置核实 |
| JoyTag 预处理 | 白底补成正方形，bicubic 到 448；RGB、NCHW、CLIP 均值/标准差，sigmoid 后阈值。[CPU 演示代码](https://huggingface.co/spaces/fancyfeast/joytag/blob/2ef0e06691f5c2e0e8d7903f5bd4b5c46b4b87f9/app.py) | 模型词表顺序和输出索引必须固定 |
| CPU/CUDA | EVA 有 Torch/ONNX 路径；JoyTag 作者同时提供 CPU 与 CUDA 示例，CUDA 示例使用 autocast | 本次未在 Windows 本地运行；不能据此承诺每台设备成功或某种延迟 |
| DirectML | 两者都有作者发布的 ONNX 文件 | 本次未找到作者对本模型 DirectML 的成功测试、速度或兼容矩阵；ONNX 格式不等于已验证 DirectML |
| 算量 | EVA 模型卡给出 FLOPs **620.9G**、MACs **310.1G**。[模型卡](https://huggingface.co/animetimm/eva02_large_patch14_448.dbv4-full) | FLOPs 不是毫秒，也不能推出不同运行时吞吐 |
| 延迟、批量吞吐、峰值内存/显存 | 所查作者资料中未发现可用于 Windows 比较的统一硬件结果 | 都未知；不能把权重磁盘大小写成 RAM/VRAM 需求，不能据参数量给出速度排名 |

模型卡许可字段：EVA 为 `gpl-3.0`，JoyTag 为 `apache-2.0`；JoyTag 源代码仓库也标 Apache-2.0。本条仅记录发布者字段，不代替关于 Kinshoko 分发、打包、再发布义务的法律结论。[EVA 元数据](https://huggingface.co/api/models/animetimm/eva02_large_patch14_448.dbv4-full?blobs=true)、[JoyTag 元数据](https://huggingface.co/api/models/fancyfeast/joytag?blobs=true)、[JoyTag LICENSE](https://github.com/fpgaminer/joytag/blob/ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb/LICENSE)

对 Kinshoko 的优先验证建议（工程判断）：先把两者接到同一套预处理明确、保留全部分数的测试接口，用共同词表的发色/发长/刘海/眼睛正负例测 Precision、Recall 和组合检索命中；同时测第一次导入的持续吞吐与绘画时单张增量延迟。EVA 先验证获取门禁与完整词表；JoyTag 特别验证细造型漏检。都不应先把所有预测自动变成人工确认标签。


### C. Camie v2 与 PixAI v0.9

#### 固定版本与证据边界

| 资料 | 本次固定版本 | 证据身份 |
| --- | --- | --- |
| `Camais03/camie-tagger-v2` | `7d40c1b85b86ab4f607b2caf26b1b50c99db743e` | 作者模型、元数据、训练 notebook、推理代码、评测 JSON。[固定仓库 API](https://huggingface.co/api/models/Camais03/camie-tagger-v2/revision/7d40c1b85b86ab4f607b2caf26b1b50c99db743e?blobs=true) |
| `pixai-labs/pixai-tagger-v0.9` | `fe57a3cec0cc2094c325924dc675dd63adff33cc` | 作者模型卡及公开文件元数据；原仓库文件访问有门禁，本次未接受条件或读取门禁内原始标签 JSON／权重。[固定仓库 API](https://huggingface.co/api/models/pixai-labs/pixai-tagger-v0.9/revision/fe57a3cec0cc2094c325924dc675dd63adff33cc?blobs=true)、[当前作者模型卡](https://huggingface.co/pixai-labs/pixai-tagger-v0.9) |
| `deepghs/pixai-tagger-v0.9-onnx` | `d8cf666911a2c3d10d586d7823259192313c7eb7` | ONNX 转换发布者的一手文件与元数据。PixAI 作者模型卡明确链接、认可这个 ONNX 版本；它不是 PixAI 作者仓库原生发布的 ONNX。[固定仓库 API](https://huggingface.co/api/models/deepghs/pixai-tagger-v0.9-onnx/revision/d8cf666911a2c3d10d586d7823259192313c7eb7?blobs=true)、[转换模型卡](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx) |
| PixAI 作者公开 Demo，v0.9 历史快照 | `811b0fa52e1d614d6c2dfbff486fb489a5045e6d` | 作者公开部署代码，包含 `model_v0.9.pth` 加载、CPU／CUDA 选择和预处理。[固定 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py) |
| DeepGHS `imgutils` | `46df848dc4d20ac93f4919a40e2636d5f7c19766` | 转换／调用实现的本次固定源码。[PixAI 调用器](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/pixai.py)、[导出器](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/zoo/pixai_tagger/export.py) |

PixAI 模型卡链接的作者 Demo 当前已升级到 v1.0，因此本笔记读取上述 **v0.9 历史快照**，没有把当前 Demo 的新能力归入 v0.9。[Demo 提交记录](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/commits/main)

#### 训练领域、架构与输入

| 维度 | Camie v2 | PixAI v0.9 |
| --- | --- | --- |
| 训练领域 | 作者声明：Danbooru 2024 的动漫／漫画插画，约 300 万张经过筛选的候选中取 200 万张训练；过滤要求图片至少含 25 个 general、1 个 character、1 个 copyright 标签。稀有标签保留门槛依类别不同。[作者模型卡](https://huggingface.co/Camais03/camie-tagger-v2) | 作者声明：Danbooru 截至 `2025-01` 的快照，继续训练时间为 `2025-04`；过滤低于 600 次出现的标签及少于 10 个 general 标签的图片。这是作者描述的训练领域，不是对个人图库的验证。[作者模型卡](https://huggingface.co/pixai-labs/pixai-tagger-v0.9) |
| 架构 | ViT `vit_base_patch16_384`，随后适配输入尺寸；整体 **143,033,727** 参数，backbone **86,434,560** 参数。全局初始标签预测后选候选标签，以 cross-attention 得到 refined logits。[固定元数据](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json)、[架构代码](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/app/utils/model_loader.py) | 冻结 WD EVA02 Large v3 encoder，继续训练线性分类头；作者公开代码的头为 **1024 → 13,461**。转换发布者统计整体 **317,852,757** 参数；参数数值来自转换工具统计，不是性能实测。[作者固定 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py)、[转换元数据](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/blob/d8cf666911a2c3d10d586d7823259192313c7eb7/meta.json) |
| 输入 | **512 × 512**、RGB、NCHW、元数据声明 `float32`；保持长宽比缩放，用均值色 `(124,116,104)` 补边；ImageNet mean `(0.485,0.456,0.406)`、std `(0.229,0.224,0.225)`。[元数据](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json)、[作者预处理](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/onnx_inference.py) | 作者 v0.9 handler 与转换配置一致：RGB，透明图合白底，直接 resize 到 **448 × 448**，ToTensor 后 mean／std 均为 `(0.5,0.5,0.5)`，即归一化到约 `[-1,1]`。此路径没有 [SmilingWolf WD ONNX 示例](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)的 BGR 反转，也没有正方形补边。[作者 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py)、[转换预处理配置](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/blob/d8cf666911a2c3d10d586d7823259192313c7eb7/preprocess.json) |
| 标签范围 | **70,527**：general **30,841**、character **26,968**、copyright **5,364**、artist **7,007**、meta **323**、rating **4**、year **20**。这些是模型输出类别的数量，不是逐类识别能力保证。[固定元数据](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json) | 公开 ONNX 词表实际为 **13,461**：general **9,741**、character **3,720**。版权／IP 信息在部署代码中由识别到的角色查 `character_ip_mapping` 得到，不是此词表的第三个独立分类输出。[固定词表](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/blob/d8cf666911a2c3d10d586d7823259192313c7eb7/selected_tags.csv)、[作者 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py) |

**对发型改进的证据边界：**PixAI 作者强调新的角色覆盖和 recall 取向；“encoder frozen”说明更新重点在标签决策头，不构成它更懂发色、刘海或局部眼睛的证据。分类头可以对原有特征学习不同决策边界，但目标属性是否改善，仍需目标样本评测；这是依据架构的推论，不是已测结论。

#### 目标词表的实际覆盖

下面逐项检查了 Camie 的固定 `tag_to_category` 与 PixAI ONNX 的固定 CSV。**“有”只表示该精确名称是可输出标签；不表示每次可靠识别，也不表示模型知道用户的中文术语。**这两份词表中的以下视觉属性都归 general。[Camie 固定词表来源](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json)、[PixAI ONNX 固定词表来源](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/blob/d8cf666911a2c3d10d586d7823259192313c7eb7/selected_tags.csv)

| 用户需求 | 两者都存在的精确标签示例 | 已核实差异／缺口 |
| --- | --- | --- |
| 发色 | `black_hair`、`brown_hair`、`blonde_hair`、`white_hair`、`grey_hair`、`blue_hair`、`red_hair`、`pink_hair`、`purple_hair`、`green_hair`、`orange_hair`、`aqua_hair`、`multicolored_hair` | Camie 有 `silver_hair`；PixAI ONNX 无此精确标签。是否应将“银发”映射到灰／白发，属于应用与用户的术语决策。 |
| 发长 | `short_hair`、`medium_hair`、`long_hair`、`very_long_hair`、`bob_cut` | 两者均无 `shoulder-length_hair` 和 `chin-length_hair` 这两个精确名称；不应承诺这些词直接对应模型输出。 |
| 刘海 | `blunt_bangs`、`parted_bangs`、`swept_bangs`、`asymmetrical_bangs`、`long_bangs`、`short_bangs`、`wispy_bangs`、`choppy_bangs`、`hair_between_eyes`、`hair_over_one_eye` | Camie 还有 `no_bangs`、`medium_bangs`、`split_bangs`；PixAI ONNX 未见这些精确名称。两者均无笼统的 `bangs` 和 `side-swept_bangs` 精确名称，应采用词表与别名映射。 |
| 中分 | 两者有 `parted_hair`、`parted_bangs` | **Camie 有 `middle_part`；PixAI ONNX 无 `middle_part`。**`parted_bangs` 或 `parted_hair` 不能未经领域对齐就视为严格的“中分”等价词。两者均无 `center_parting`、`middle-parted_hair` 精确名称。 |
| 眼睛 | 颜色：`blue_eyes`、`red_eyes`、`green_eyes`、`brown_eyes`、`yellow_eyes`、`purple_eyes`、`pink_eyes`、`grey_eyes`、`aqua_eyes`、`black_eyes`、`multicolored_eyes`、`heterochromia`；形态／状态：`tsurime`、`tareme`、`sanpaku`、`closed_eyes`、`one_eye_closed`、`half-closed_eyes`、`narrowed_eyes`、`eyelashes` | 未找到作者对这些目标单标签或眼睛局部的分项 precision／recall／F1。 |

PixAI 原作者的 `tags_v0.9_13k.json` 有门禁；本次覆盖结论严格指作者认可的 **DeepGHS v0.9 ONNX 词表**。转换代码将原始标签次序转成 CSV，并把 IP 映射附在角色标签上，可追溯转换方法；本次没有逐字节比对受门禁保护的原 JSON。[转换代码](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/zoo/pixai_tagger/export.py)

#### 作者准确度：可引用数字与不可直接比较之处

##### Camie 的原始评测

作者发布 JSON 记录评测日期 **2025-08-30**、**20,116** 个样本。Notebook 对数据做随机验证划分，`test_size=0.01`、`random_state=42`；宏平均函数只纳入在验证标签中有正例的类别。其输出表是作者验证集结果，不是用户图库的泛化准确率。[原始评测 JSON](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/full_validation_results.json)、[原始训练／评估 notebook](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/training/camie-tagger-v2.ipynb)

| 阈值方案 | 阈值（四舍五入） | 总体 micro F1 | 总体 macro F1 | general micro F1 | general macro F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| MICRO OPT | 0.614286 | 67.35% | 46.29% | 66.41% | 27.40% |
| MACRO OPT | 0.491837 | 60.91% | 50.62% | 60.23% | 34.58% |

该表所有数字均来自上述[固定原始评测 JSON](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/full_validation_results.json)。不能把 **67.35% micro** 与 **50.62% macro** 拼成同一阈值的成绩，也不能把总体／general F1 当成中分、刘海或发色的 F1。作者发布结果文件没有逐目标属性的 precision／recall，亦未找到该固定发布版本的 mAP 汇总；这些数值记为**未知**。Notebook 中个别示例图的 P／R 不是总体评测。

##### PixAI 的作者自报与内部比较

当前作者模型卡自报：全标签 micro F1 约 **0.60**；角色子集 F1 **0.865**，角色阈值 **0.75**。模型卡推荐 general 阈值 **0.30**、character **0.75**；公开 v0.9 handler 和 DeepGHS ONNX threshold CSV 的 character 默认却为 **0.85**。因此发布卡成绩不能无条件视为“按现成部署默认值”得到的成绩。[作者模型卡](https://huggingface.co/pixai-labs/pixai-tagger-v0.9)、[作者固定 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py)、[固定 thresholds CSV](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/blob/d8cf666911a2c3d10d586d7823259192313c7eb7/thresholds.csv)

模型卡的内部比较是同一个作者所称的协议，可以保留为有范围的自报证据：

| 作者表中的模型名 | Coverage-F1 | Accuracy-F1 | Acc-Recall | Acc-Precision | Cov-Precision | Cov-Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| PixAI v0.9 | 0.4910 | 0.4403 | 0.6654 | 0.3634 | 0.4350 | 0.6547 |
| WD-v3-EVA02 | 0.4155 | 0.4608 | 0.4465 | 0.5248 | 0.4580 | 0.4083 |
| Camie-70k | 0.4877 | 0.4800 | 0.5743 | 0.4123 | 0.4288 | 0.5930 |

所有数字来源：[PixAI 作者模型卡内部表](https://huggingface.co/pixai-labs/pixai-tagger-v0.9)。该页未完整给出 Coverage／Accuracy 指标构造、精确评测样本列表和全部模型权重 revision；`Camie-70k` 也未明确对应本笔记的 Camie v2 固定版本。因此这些数字不能与 Camie 自己的验证集成绩混排，也不能形成针对发型／眼睛的模型排名。本次未取得 PixAI 原始逐样本结果、目标属性分项 P／R／F1、macro F1 或 mAP；记为**未知**。

#### 裁切局部能否识别

**代码层面：能把裁切图作为普通图片送入。**Camie CLI 接受本地图片路径，保持比例缩放后补边；PixAI handler 接受 PIL 图片并直接缩放。接口没有要求输入必须是整幅作品，也没有专门的“头发／眼睛裁切分类”模式。[Camie 输入处理](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/onnx_inference.py)、[PixAI 输入处理](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py)

**识别层面：未知。**在本次读到的模型卡、评测文件和 notebook 中，没有找到“整图与同图局部裁切”的受控对比，也没有头发、眼睛、刘海、中分裁切数据集的分项成绩。不能把能够输入、patch attention、角色 F1 或全图 sample 演示当成裁切可靠性的证明。

**领域推论：**局部裁切会改变语境和有效分辨率；只保留刘海的裁切不能显示原图的完整发长，只保留一只眼睛也不能显示另一只眼的颜色。多人整图标签组合不保证属性属于同一人；对裁切重新推理可以缩小输入范围，但它仍只给这张输入图标签，应用仍需保存裁切范围和原图关系。这些是信息／接口边界，不是已测的性能结论。[Camie 标签输出映射](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/app/utils/onnx_processing.py)、[PixAI 标签输出](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/pixai.py)

#### 权重体积、dtype、Windows 部署与离线

| 发布文件 | 精确磁盘大小 | 来源 |
| --- | ---: | --- |
| Camie `camie-tagger-v2.onnx` | **788,983,561 bytes**，约 **789 MB**（十进制） | [固定模型仓库 API](https://huggingface.co/api/models/Camais03/camie-tagger-v2/revision/7d40c1b85b86ab4f607b2caf26b1b50c99db743e?blobs=true) |
| Camie `camie-tagger-v2.safetensors` | **572,151,796 bytes**，约 **572 MB** | [同一固定 API](https://huggingface.co/api/models/Camais03/camie-tagger-v2/revision/7d40c1b85b86ab4f607b2caf26b1b50c99db743e?blobs=true) |
| PixAI 作者 `model_v0.9.pth` | **1,271,546,227 bytes**，约 **1.272 GB** | [作者固定 API](https://huggingface.co/api/models/pixai-labs/pixai-tagger-v0.9/revision/fe57a3cec0cc2094c325924dc675dd63adff33cc?blobs=true) |
| DeepGHS PixAI `model.onnx` | **1,271,365,854 bytes**，约 **1.271 GB** | [转换仓库固定 API](https://huggingface.co/api/models/deepghs/pixai-tagger-v0.9-onnx/revision/d8cf666911a2c3d10d586d7823259192313c7eb7?blobs=true) |

**这些是文件体积，不是 RAM／VRAM 需求。**本次没有测峰值内存；不能用文件大小推算模型加速器工作区、激活、图优化副本、批量输入或应用总占用，也不能由参数数和输入尺寸推算 CPU 实际延迟。

| 项目 | Camie v2 | PixAI v0.9 |
| --- | --- | --- |
| dtype／量化 | 元数据明确输入与 initial／refined 输出为 `float32`，candidate 索引为 `int64`。作者导出代码把 safetensors 中半精度状态转成 float，并以 float32 dummy input 导出 ONNX。固定作者仓库未提供独立 FP16／INT8 ONNX 项；没有作者量化后准确率数据。[元数据](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/camie-tagger-v2-metadata.json)、[导出 notebook](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/training/camie-tagger-v2.ipynb) | 作者公开 handler 和转换器没有 half／INT8 量化步骤；转换发布仓库仅给上述 `model.onnx`。这是代码路径证据，本次未下载 graph 逐个核对 initializer 的 dtype，也没有量化保真／速度成绩。[作者 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py)、[转换器](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/zoo/pixai_tagger/export.py) |
| CPU／CUDA 代码证据 | 作者 ONNX 代码列出 CUDA 与 CPU provider，并有 CPU 回落。训练／验证 notebook 留有 CUDA 混合精度路径和评测输出，但它不是 Windows ONNX 部署 benchmark。[ONNX 调用器](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/app/utils/onnx_processing.py)、[作者 notebook](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/training/camie-tagger-v2.ipynb) | 作者 v0.9 handler 探测可用 CUDA，否则 CPU，并包含 `FORCE_CPU` 处理；DeepGHS ONNX helper 默认选可用 CUDA，否则 CPU。这是已发布执行路径，不是本机实测。[作者 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py)、[DeepGHS runtime helper](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/utils/onnxruntime.py) |
| Windows DirectML | 作者固定调用器未给 DirectML provider，未找到作者提供的该模型 Windows DirectML 性能／全算子部署结果。**未知。** | 作者 v0.9 部署走 PyTorch CPU／CUDA；转换 helper 可接受 provider 名称，但没有该模型 DirectML 成功、GPU 算子覆盖与性能实测。**未知。** |
| 延迟／吞吐／内存 | 未找到带明确 Windows 硬件、运行时版本、batch、预热条件的可复现单图延迟／吞吐／峰值 RAM、VRAM 结果。作者 notebook 的评估进度条没有足够硬件与部署信息，不能转换为产品速度承诺。 | handler 有计时字段与计时日志代码，但没有绑定明确硬件、运行时及 batch 的发布测量结果。单图延迟、批量吞吐、峰值 RAM／VRAM **未知**。 |
| batch 能力 | 作者导出器可声明动态 batch 轴；实际性能、最佳 batch 与内存上限未知。[导出代码](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/training/camie-tagger-v2.ipynb) | DeepGHS 导出器声明动态 batch 轴，但公开 `get_pixai_tags` 调用器每次给单张图加 batch 轴；动态维度不等于已验证高吞吐接口。[导出器](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/zoo/pixai_tagger/export.py)、[调用器](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/pixai.py) |
| 首次下载 | 作者模型仓库 API 为 `gated=false`，公开文件可以取得。[固定 API](https://huggingface.co/api/models/Camais03/camie-tagger-v2/revision/7d40c1b85b86ab4f607b2caf26b1b50c99db743e?blobs=true) | 作者仓库 API 为 `gated=auto`，页面要求登录并同意共享联系信息／访问条件；DeepGHS 转换仓库 `gated=false`。两条取得路径必须区分。[作者页面](https://huggingface.co/pixai-labs/pixai-tagger-v0.9)、[转换固定 API](https://huggingface.co/api/models/deepghs/pixai-tagger-v0.9-onnx/revision/d8cf666911a2c3d10d586d7823259192313c7eb7?blobs=true) |

**离线可行性的代码审查结论：**两者均有本地文件输入与本地执行路径。完整取得权重、元数据／词表、预处理及运行时依赖后，可以构建离线 ONNX 推理；本次没有断网运行验证。Camie 的单独 ONNX 脚本只读取本地权重／元数据，避免了其 safetensors 参考 loader 中 `pretrained=True` 带来的额外模型初始化下载。PixAI 的 DeepGHS helper 会调用 `hf_hub_download`；作者 PyTorch 路径也用 `hf_hub:` 创建 base encoder，首次初始化还须处理配置缓存。[Camie ONNX 脚本](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/onnx_inference.py)、[Camie safetensors loader](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/app/utils/model_loader.py)、[PixAI 调用器](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/imgutils/tagging/pixai.py)、[作者 handler](https://huggingface.co/spaces/pixai-labs/pixai-tagger-demo/blob/811b0fa52e1d614d6c2dfbff486fb489a5045e6d/handler.py)

HF 官方说明：即便已有缓存，普通 `hf_hub_download` 仍可能查询更新；`HF_HUB_OFFLINE=1` 才禁止 Hub HTTP 调用，只读缓存，缺文件时失败。因而“本地模型”与“现成 wrapper 保证不联网”应分开验证。[HF 离线变量文档](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables#hfhuboffline)

#### 接入风险与许可事实

1. **输出激活不能混用。**Camie 的 initial／refined 是 logits，公开处理代码再做 sigmoid；`selected_candidates` 是标签索引，不是人物坐标。DeepGHS PixAI ONNX 输出 `embedding/logits/prediction`，`prediction` 已过 sigmoid，再做一次 sigmoid 会改坏分数；`logits` 才需要 sigmoid。[Camie 输出规格与处理](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/app/utils/onnx_processing.py)、[PixAI ONNX wrapper](https://github.com/deepghs/imgutils/blob/46df848dc4d20ac93f4919a40e2636d5f7c19766/zoo/pixai_tagger/onnx.py)
2. **预处理应随具体 artifact 固定。**本笔记的两条路径都用 RGB，但尺寸、补边与归一化不同。不能把 [SmilingWolf WD ONNX 示例](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)的 BGR／像素尺度前处理直接套到 PixAI 的这个转换文件上；也不能用 PixAI 的直接拉伸替换 Camie 的比例补边而假定结果不变。[Camie 预处理](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/onnx_inference.py)、[PixAI 固定预处理](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/blob/d8cf666911a2c3d10d586d7823259192313c7eb7/preprocess.json)
3. **标签阈值、术语与人工修正属于应用。**中文“中分／斜刘海／齐肩”要与具体词表、别名和产品定义对齐；分数与人工纠错来源应能区分。模型词表更广、角色 F1 更高、框架能选 GPU，都不能代替这些定义或目标样本验证。
4. **维护和版本需要可追溯。**作者 model card、公开 Demo、ONNX 转换与 wrapper 可以独立更新；尤其 PixAI 当前 Demo 已升级。应用集成应记录 artifact revision／hash、词表版本、前处理、输出名和阈值策略。上述是依据已观察到的多个发布层提出的集成审计事项，不是 Kinshoko 最终架构。

当前官方许可声明：Camie 模型卡与 `config.json` 为 **GPL-3.0**；PixAI 当前模型卡明确写 weights 为 **Apache 2.0**，DeepGHS 转换模型卡也标 Apache-2.0。PixAI **2025-09-10** 官方公告却称 **MIT**，与当前权重声明不一致；本次没有通过读取门禁内权重许可文件消除差异，也不把 Demo 的 MIT 元数据当成权重许可。这些仅是官方声明事实，不给出再分发的法律结论。[Camie 当前卡](https://huggingface.co/Camais03/camie-tagger-v2)、[Camie 固定配置](https://huggingface.co/Camais03/camie-tagger-v2/blob/7d40c1b85b86ab4f607b2caf26b1b50c99db743e/config.json)、[PixAI 当前卡](https://huggingface.co/pixai-labs/pixai-tagger-v0.9)、[DeepGHS 转换卡](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx)、[PixAI 官方旧公告](https://pixai.art/zh/news/1922467562068629237)

用于复核发布文件的 SHA-256（来源为各固定 HF API 的 LFS 元数据，未下载后自行校验）：

| artifact | SHA-256 |
| --- | --- |
| Camie ONNX | `ab0aaf253e3d546090001bec9bebc776c354ab6800f442ab9167af87b4a953ac` |
| Camie safetensors | `81b1f1caaf84afc2e91204e1d01163487b90720f797af8b64eea331bf16b3f25` |
| PixAI 作者 `.pth` | `1706e043733c5b3bec6826d1cc775b549ba6977191bcc50fe4999143461ae74f` |
| DeepGHS PixAI ONNX | `a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657` |

哈希直接来源：[Camie 固定 API](https://huggingface.co/api/models/Camais03/camie-tagger-v2/revision/7d40c1b85b86ab4f607b2caf26b1b50c99db743e?blobs=true)、[PixAI 固定 API](https://huggingface.co/api/models/pixai-labs/pixai-tagger-v0.9/revision/fe57a3cec0cc2094c325924dc675dd63adff33cc?blobs=true)、[DeepGHS 固定 API](https://huggingface.co/api/models/deepghs/pixai-tagger-v0.9-onnx/revision/d8cf666911a2c3d10d586d7823259192313c7eb7?blobs=true)。
