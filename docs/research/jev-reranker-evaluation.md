# Jev 与候选用途判断：Kinshoko 适用性评估

初次研究：2026-10-01；复核更新：2026-10-07。评估对象是 [introducing-jev-reranker](https://huggingface.co/blog/hotchpotch/introducing-jev-reranker) 及其背后的按指令做结构化判断的思路。本次补核 OpenAI Decisions API public beta、Jev 当前模型规格与 confidence 定义；第三方 reranker 和社区项目的源码记录仍以初次研究为准，没有重新运行或全面复查。没有注册服务、调用付费 API、安装依赖、上传参考图或元数据，也没有在本项目运行评测。下文的增强用途是研究提案。

证据口径：**文档／源码核查**能确认公开接口和实现；**厂商自报**记录其性能或能力声明，未经本次复现；**本次判断**是接口边界推论。三者不应混为个人资料库上的实测效果。

## 2026-10-07 复核更新

- **OpenAI Decisions API 已成为可直接比较的后端。**官方 changelog 确认 2026-10-06 发布 beta；指南确认 public beta，当前模型为 `gpt-6-luna`，可接收文字与图像，返回 Predicate／Choice／Score 判断。旧多模态笔记中的“尚未确认该接口名称”已在[更新报告](multimodal-decisions-evaluation.md)中修正。[官方发布记录](https://developers.openai.com/api/docs/changelog)、[Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)
- **看图的小判断应优先验证直接多模态路径。**Jev 当前仍只接受文字；原图或现有局部直接进入 Decisions，可以减少临时生成描述的串行步骤。这个流程判断不证明比 Jev 更快或更准；文字与状态已足够的问题仍可比较 Jev。[Jev 输入](https://docs.typesafe.ai/concepts/state)、[Decisions 输入契约](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- **两家的接口与分数要分别处理。**Jev 的 `state`、问题 map、`noul` 和 `criteria`，不能直接当作 Decisions 的 `input`、问题数组、`predicate`、`choices`／`levels`。新实验应固定相同问题、证据和答案空间，为各后端分别构造请求与读取结果。[TypeSafe API](https://docs.typesafe.ai/api)、[OpenAI API](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- **项目范围已有后续决定。**[首版规格 #42](https://github.com/Yukk1No/kinshoko/issues/42)与[技术路线](../discovery/technical-route.md)已确定本地实现；内置近似对应表与个人近似对应表进入首版，Jev 与模型辅助仍在 roadmap（[ADR-0003](../adr/0003-tag-identity-and-approximate-search.md)）。公测开放只改变可验证性，不代表已选定供应商或新增首版能力。

## 评估结论

**按发起者反馈修正定位：Jev 应是需要及时响应的局部语义判断模型，处在纯机械规则与较重模型之间。**不能以高正确率为设计前提，也不能仅凭低价格与结构化输出把批量审核、分类或质量评价交给它。是否值得接入，要看相对规则是否补足了有用的语义判断、相对较重模型是否缩短了等待，以及误判后能否轻松继续操作。更广泛的社区用途及修订后的优先级见 [社区应用评估](jev-community-use-cases.md)。

检索中适合先研究的是已经召回候选后的临时排序或轻提示：原结果先可用，判断在本次交互有效期内返回才应用，错误不裁定图像事实或改变长期元数据。当前 Jev 只有文本输入，其判断仍依赖已有标签、备注或描述。此处是设计约束，不是已经实测的速度或准确率结论。

我们已确认首版的文字与点击标签表达同一组条件，支持中文别名与组合查询；返回整图候选，人物属性关联与自由描述另行验证。主要使用方式是 Windows 本地，自动结果参与检索、人工决定优先。Jev 在 roadmap 中用于从库内已有标签提出近似查找候选；本文讨论的即时意图判断、按用途重排与视觉小判断均是额外研究方向，首版的基础检索仍由标签规则负责。[领域对齐](../discovery/alignment.md)、[Roadmap](../discovery/roadmap.md)

| Kinshoko 场景 | Jev 直接接入的价值与边界 | 本次建议 |
| --- | --- | --- |
| 输入“蓝发、短发”或点击对应标签 | 已知名称与别名可以直接解析。增加概率判断可能让两种入口出现不同结果。 | 优先完成明确、可解释的条件检索；后续可在相同候选中重排。 |
| 含糊的自然语言，例如“想找这种刘海的参考” | 可在预先给出的标签解释或候选描述中判断；缺少示例图片或文字描述时，输入本身不够。 | 作为查询理解实验；输出候选条件，允许用户确认，不自动建立永久别名。 |
| 按绘画用途找图，例如“便于看清发束走向” | 有准确备注或描述时，可按用途重排；普通整图标签可能没有可见程度、遮挡、视角等信息。 | 已有描述可复用且判断赶得上当次查找时，验证临时排序；视觉描述或重模型耗时要算入完整流程。 |
| 自动识别发色、发型、眼睛及区域属性 | Jev 看不到原图；从缺少人物归属的标签列表推导同一人物属性，没有可靠证据。 | 图像识别仍复用专门模型；区域／人物关联单独验收。[标签接口核查](tagger-integration.md) |
| 推荐加入参考组的图或已有参考视图 | 可对有描述的候选给建议，效果取决于能否表达参考目的。 | 后续实验；保存哪些成员及其裁切、布局仍由用户操作和参考组规则决定。 |
| 完全相同原图合并、引用迁移、备份与同步冲突 | 概率判断不满足这些操作所需的身份与保全规则。 | 用明确规则落实已确认的数据行为；冲突建议可以另外评估。 |

更广泛的启发是：把“判断候选的用途”作为可测、可替换的职责，应用自己保存条件、执行流程和处理失败。采用这种职责划分不需要承诺 Jev，也不要求现在训练自己的通用决策模型。

## 分篇

### 接口与部署事实

- [Jev 与 reranker 是不同层次](jev-reranker-evaluation/layers.md)：通用判断模型与检索重排器的边界。
- [输入、输出与分数含义](jev-reranker-evaluation/input-output-scores.md)：state、问题原语、概率与 confidence 的解释。
- [版本、上下文、语言与部署](jev-reranker-evaluation/versions-context-language-deployment.md)：模型版本、上下文长度、语言与调用形态。
- [费用、延迟与吞吐](jev-reranker-evaluation/cost-latency-throughput.md)：厂商自报成本与速度及其限制。
- [数据处理与许可](jev-reranker-evaluation/data-processing-license.md)：数据处理条款、许可与本地合规边界。

### 证据、流程与验证

- [可以借鉴的接口思路与尚未证实的事项](jev-reranker-evaluation/interface-ideas-unproven.md)：可借鉴接口形态和仍缺证据的能力。
- [原文的实验能证明什么](jev-reranker-evaluation/paper-experiments.md)：原作者实验能支持与不能支持的结论。
- [怎样把思路放进查找流程](jev-reranker-evaluation/search-flow.md)：临时排序、轻提示与失败处理流程。
- [其他可比较的实现路径](jev-reranker-evaluation/alternative-implementations.md)：Jev、Decisions、本地模型与规则的比较。
- [对当前建模的影响](jev-reranker-evaluation/modeling-impact.md)：职责划分、元数据边界与长期状态影响。
- [建议的最小验证](jev-reranker-evaluation/minimal-validation.md)：接入前最小可行实验与判定标准。
