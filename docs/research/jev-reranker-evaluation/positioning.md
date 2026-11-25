# 定位与结论

[← 返回索引](../jev-reranker-evaluation.md)

## 2026-10-07 复核更新

- **OpenAI Decisions API 已成为可直接比较的后端。**官方 changelog 确认 2026-10-06 发布 beta；指南确认 public beta，当前模型为 `gpt-6-luna`，可接收文字与图像，返回 Predicate／Choice／Score 判断。旧多模态笔记中的“尚未确认该接口名称”已在[更新报告](../multimodal-decisions-evaluation.md)中修正。[官方发布记录](https://developers.openai.com/api/docs/changelog)、[Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)
- **看图的小判断应优先验证直接多模态路径。**Jev 当前仍只接受文字；原图或现有局部直接进入 Decisions，可以减少临时生成描述的串行步骤。这个流程判断不证明比 Jev 更快或更准；文字与状态已足够的问题仍可比较 Jev。[Jev 输入](https://docs.typesafe.ai/concepts/state)、[Decisions 输入契约](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- **两家的接口与分数要分别处理。**Jev 的 `state`、问题 map、`noul` 和 `criteria`，不能直接当作 Decisions 的 `input`、问题数组、`predicate`、`choices`／`levels`。新实验应固定相同问题、证据和答案空间，为各后端分别构造请求与读取结果。[TypeSafe API](https://docs.typesafe.ai/api)、[OpenAI API](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- **项目范围已有后续决定。**[首版规格 #42](https://github.com/Yukk1No/kinshoko/issues/42)与[技术路线](../../discovery/technical-route.md)已确定本地实现；内置近似对应表与个人近似对应表进入首版，Jev 与模型辅助仍在 roadmap（[ADR-0003](../../adr/0003-tag-identity-and-approximate-search.md)）。公测开放只改变可验证性，不代表已选定供应商或新增首版能力。

## 评估结论

**按发起者反馈修正定位：Jev 应是需要及时响应的局部语义判断模型，处在纯机械规则与较重模型之间。**不能以高正确率为设计前提，也不能仅凭低价格与结构化输出把批量审核、分类或质量评价交给它。是否值得接入，要看相对规则是否补足了有用的语义判断、相对较重模型是否缩短了等待，以及误判后能否轻松继续操作。更广泛的社区用途及修订后的优先级见 [社区应用评估](../jev-community-use-cases.md)。

检索中适合先研究的是已经召回候选后的临时排序或轻提示：原结果先可用，判断在本次交互有效期内返回才应用，错误不裁定图像事实或改变长期元数据。当前 Jev 只有文本输入，其判断仍依赖已有标签、备注或描述。此处是设计约束，不是已经实测的速度或准确率结论。

我们已确认首版的文字与点击标签表达同一组条件，支持中文别名与组合查询；返回整图候选，人物属性关联与自由描述另行验证。主要使用方式是 Windows 本地，自动结果参与检索、人工决定优先。Jev 在 roadmap 中用于从库内已有标签提出近似查找候选；本文讨论的即时意图判断、按用途重排与视觉小判断均是额外研究方向，首版的基础检索仍由标签规则负责。[领域对齐](../../discovery/alignment.md)、[Roadmap](../../discovery/roadmap.md)

| Kinshoko 场景 | Jev 直接接入的价值与边界 | 本次建议 |
| --- | --- | --- |
| 输入“蓝发、短发”或点击对应标签 | 已知名称与别名可以直接解析。增加概率判断可能让两种入口出现不同结果。 | 优先完成明确、可解释的条件检索；后续可在相同候选中重排。 |
| 含糊的自然语言，例如“想找这种刘海的参考” | 可在预先给出的标签解释或候选描述中判断；缺少示例图片或文字描述时，输入本身不够。 | 作为查询理解实验；输出候选条件，允许用户确认，不自动建立永久别名。 |
| 按绘画用途找图，例如“便于看清发束走向” | 有准确备注或描述时，可按用途重排；普通整图标签可能没有可见程度、遮挡、视角等信息。 | 已有描述可复用且判断赶得上当次查找时，验证临时排序；视觉描述或重模型耗时要算入完整流程。 |
| 自动识别发色、发型、眼睛及区域属性 | Jev 看不到原图；从缺少人物归属的标签列表推导同一人物属性，没有可靠证据。 | 图像识别仍复用专门模型；区域／人物关联单独验收。[标签接口核查](../tagger-integration.md) |
| 推荐加入参考组的图或已有参考视图 | 可对有描述的候选给建议，效果取决于能否表达参考目的。 | 后续实验；保存哪些成员及其裁切、布局仍由用户操作和参考组规则决定。 |
| 完全相同原图合并、引用迁移、备份与同步冲突 | 概率判断不满足这些操作所需的身份与保全规则。 | 用明确规则落实已确认的数据行为；冲突建议可以另外评估。 |

更广泛的启发是：把“判断候选的用途”作为可测、可替换的职责，应用自己保存条件、执行流程和处理失败。采用这种职责划分不需要承诺 Jev，也不要求现在训练自己的通用决策模型。

## Jev 与 reranker 是不同层次

Jev 是 TypeSafe 的通用文本决策模型，输入一份 `state` 和多个预先定义答案空间的问题，返回有类型的判断与概率。官方明确说明它不生成回复、代码或推理解释；当前只接受文本、JSON 对象和数组，不接受图像、音频或视频。[System One](https://docs.typesafe.ai/concepts/system-one)、[State](https://docs.typesafe.ai/concepts/state)

`hotchpotch/jev-reranker` 是第三方 Python 封装：输入文字查询与候选文档，调用 Jev API 得分，再排序或按阈值过滤。它不是新训练的图像模型，也不是可下载的 Jev 权重。作者把用途放在检索之后、RAG 组装上下文之前；基础包需要 Python 3.11+ 和 TypeSafe API key。[作者 README](https://github.com/hotchpotch/jev-reranker)

**接口边界推论：**对 Kinshoko 直接送参考图做发型识别，目前没有 Jev 接口支持。若先把参考图转换成标签、备注或描述，再做文字判断，Jev 判断的是这些文字所表达的信息；不能凭这种接入自动获得文字中缺失的视觉事实。

## 输入、输出与分数含义

官方入口是 `POST https://api.typesafe.ai/v1/systemone`，Bearer API key 认证。请求包含 `model`、`state`、`questions`；回复包含模型 ID、按原问题 ID 返回的 `answers` 及 token 用量。问题 ID 本身不参与推理，因此指向候选的含义要写进问题或状态内容。[HTTP API](https://docs.typesafe.ai/api)

| 原语 | 答案空间与返回值 | 使用边界 |
| --- | --- | --- |
| Choice | 预先枚举的选项；返回最高概率选项、完整概率分布、`confidence`；最多 255 个选项。[官方 Choice](https://docs.typesafe.ai/primitives/choice) | 选项之间是相对选择；需表达“都不合适”时应提供相应选项。 |
| Score | 2–10 个按顺序排列的文字等级；返回等级概率、`legend`、加权 `score` 和 `confidence`。[官方 Score](https://docs.typesafe.ai/primitives/score) | 分数范围是 0 到等级数减 1；不是天然的 0–1 概率。 |
| Noul | 是／否问题；返回 0–1 的 `noul`，官方定义为“答案为是”的概率。[官方 Noul](https://docs.typesafe.ai/primitives/noul) | 不另带 `confidence` 字段；应用自行设决策阈值。 |

Score 为等级位置的期望值：`score = Σ(等级序号 × 该等级概率)`。例如三个等级返回 1.4，表示概率加权的位置，不表示“有 140% 的概率合适”。相同均值可能来自不同分布，应该连同原始概率和 rubric 一起解释；模型只看等级描述，不能依靠“比上一档更好”来定义标准。[Score 的读取与等级设计](https://docs.typesafe.ai/primitives/score)

**2026-10-07 修正：官方已公开 `confidence` 的明确公式。**Choice 使用 `(p_max - 1/n) / (1 - 1/n)`，只取最高选项概率与选项数；例如三选项最高概率 0.6 时 confidence 为 0.4，不由其余两项怎样分配决定。Score 使用 `max(0, 1 - Σ p_i × |i-m| / MAD_uniform)`，其中 `m` 是概率最高的等级，`MAD_uniform = Σ |i-(n-1)/2| / n`。Score 因而还计入等级之间的距离。Noul 仍只返回 yes 概率，不附 confidence；如应用另算 `|2p-1|`，应标明这是派生值。[Confidence 公式](https://docs.typesafe.ai/confidence)

这些值都不是独立核实出的正确率。不同选项集、原语、提示、模型版本和供应商下的阈值不能直接移用；尤其不能把 Jev 的公式与阈值套到 OpenAI Decisions 的同名 `confidence` 字段。[Jev 已知边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13)、[Decisions 概率说明](https://developers.openai.com/api/docs/guides/decisions)

TypeSafe 将其训练方法称为 RLCD（Reinforcement Learning for Calibrated Decisions），宣称优化决策概率的校准。官方解释的是**一组预测**中概率与实际频率的对应关系，而不是单次答案保证正确；本次没有得到 Kinshoko 内容上的校准曲线、误差或阈值实验。[AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)
