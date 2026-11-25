# 多模态小判断与 OpenAI Decisions API 核查

原调研日期：2026-10-02。复核日期：2026-10-07。

本轮使用 research 与 OpenAI Docs 技能，检索并打开一手文档。OpenAI 结论仅引用官方开发者文档；Jev 对照引用 TypeSafe 官方资料。**验证状态：文档已核实，API 未调用。** 未使用密钥、未安装 SDK，未测量速度、正确率或 Kinshoko 的端到端效果。文档公布的能力、供应商性能宣称与下文适配推论分别记录。

**适配结论：必须看图的即时小判断，应把原生图文的 Decisions API 纳入优先实验；文字与应用状态足够的问题，Jev 仍有位置。** 小判断放在机械规则与大模型之间，只承担及时、局部、容错的一步。它可以帮助当次选择，不能据此假定高正确率或扩大为批量分类、导入审核、长期质量评分。

当前 [ADR-0003](../adr/0003-tag-identity-and-approximate-search.md) 与 [roadmap](../discovery/roadmap.md) 仍把用户自填 key 的 Jev 用于近似查找，放在后续探索阶段。本文没有选定供应商，也没有新增首版功能。

## 1. 撤销旧结论：Decisions 已有正式公开 beta

2026-10-02 旧稿写“Decisions API 身份仍待确认、未找到正式公开页面”，随后以 Responses 代为评估。这项结论现已撤销。OpenAI changelog 记录 **2026-10-06** 发布 Decisions beta；当前指南明确为 **public beta**。用户此前所说的原生多模态小判断接口已能确认为这个独立端点。[OpenAI changelog](https://developers.openai.com/api/docs/changelog)、[Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)。

已公布的是 `POST /v1/decisions`，当前仅支持 `gpt-6-luna`。指南预计数周内 GA；这是预期时间，不是 GA 已完成或确定上线日。它提供三个专门原语，不能再描述成“只有 Responses + JSON schema”。[Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)。

官方称其约比 Responses API 快 10 倍；这是供应商相对通用响应接口的宣称。本文没有验证绝对毫秒数、P95、视觉任务效果，也没有 Decisions 对 Jev 的同条件性能证据。[发布记录](https://developers.openai.com/api/docs/changelog)。

## 2. Decisions 的三原语与返回语义

请求由 `model`、共享 `input`、有序 `questions` 数组构成。返回 `model`、`answers` 和 `usage`；答案顺序与问题顺序一致，问题可用 `name` 对应答案。[创建 Decision 参考](https://developers.openai.com/api/reference/resources/decisions/methods/create)。

| 问题类型 | 应用交给接口的任务 | 主要返回 |
| --- | --- | --- |
| `predicate` | 判断一个条件是否成立 | `probability`，条件为真的 0–1 估计概率 |
| `choice` | 从给定选项中选一个 | `choice`、逐选项 `probabilities`、`confidence`；值可为字符串或布尔值 |
| `score` | 按有序等级评估 | `score`、逐等级 `probabilities`、`confidence`；等级从 0 编号 |

以上字段来自 [Decision 返回类型](https://developers.openai.com/api/reference/resources/decisions/methods/create)。`score` 是等级编号的概率加权平均，可以落在两级之间；它不是任意区间内的精确测量。独立问题可共用一次输入，依赖前一步答案的问题应另发请求。[Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)。

**概率、置信度与正确率分开解释。** OpenAI 公布了选项概率和单独的 `confidence`，当前指南与参考未给出其计算公式，也未证明在中文绘画参考任务上校准良好。不能移植 Jev 的公式或阈值。Jev 已公开 Choice 和 Score 的不同计算式，Noul 只返概率；其 Choice 置信度由最高概率与选项数计算，并非熵或整份分布的集中度。[OpenAI 答案解释](https://developers.openai.com/api/docs/guides/decisions#interpret-the-answers)、[TypeSafe Confidence](https://docs.typesafe.ai/confidence)。高分仍可能选错；阈值需用本项目样本与错误代价验证。

**`refusal` 是独立返回类型。** 模型可拒答单个问题，其他问题仍能收到答案。拒答只含 `type` 与 `name`，没有选择或分数；不可当作概率为 0、低置信度或某个业务选项。[Refusal 参考](https://developers.openai.com/api/reference/resources/decisions/methods/create)。

应用若需要“证据不足／无法判断”，应明确把它列为 Choice 选项并说明适用条件。这样取得的是一个业务判断，不等同于拒答，也不保证模型会及时弃权。记录时应分开统计业务弃权、拒答、超时与请求错误。

## 3. 图像契约、认证与最小示例

使用 OpenAI API 的 Bearer 认证及 JSON 请求体。公开文档不代表具体账户已经具备权限或额度；本文未检查账户。[认证参考](https://developers.openai.com/api/reference/overview)。

Decisions 的 `input` 支持文字字符串，或仅由 `user` 消息构成的数组；消息内容为文字及 `input_image`。**图片必须是 Base64 data URL，全请求最多 128 张。** 不支持外部图片 URL、file ID、文件输入、音频、非 user 角色、工具调用或 item reference。`detail` 接受 `low`、`high`、`auto`、`original`，默认 `auto`，按模型图像配置处理。[输入参考](https://developers.openai.com/api/reference/resources/decisions/methods/create)。

以下是本文自拟的契约示例，没有执行。`BASE64_A` 与 `BASE64_B` 必须替换为真实图片内容，不能原样发送。两张图是应用已经取得的候选局部，问题只要求一次选择。

```http
POST https://api.openai.com/v1/decisions
Authorization: Bearer OPENAI_API_KEY
Content-Type: application/json
```

```json
{
  "model": "gpt-6-luna",
  "input": [
    {
      "role": "user",
      "content": [
        {"type": "input_text", "text": "用途：观察刘海的发束走向。候选 A："},
        {"type": "input_image", "image_url": "data:image/png;base64,BASE64_A", "detail": "auto"},
        {"type": "input_text", "text": "候选 B："},
        {"type": "input_image", "image_url": "data:image/png;base64,BASE64_B", "detail": "auto"}
      ]
    }
  ],
  "questions": [
    {
      "type": "choice",
      "name": "fringe_reference",
      "instructions": "哪一个局部更容易观察刘海发束的走向？只比较可见线条与遮挡；证据不足或没有明显差别时选择 unknown。",
      "choices": [
        {"value": "A", "description": "A 的发束走向更清楚。"},
        {"value": "B", "description": "B 的发束走向更清楚。"},
        {"value": "unknown", "description": "没有足够证据选出更清楚的一项。"}
      ]
    }
  ]
}
```

正常答案应按 `answers[0].type` 分支，再读取 `choice` 及概率；若为 `refusal`，停止使用该问题的判断。`usage` 包含输入、缓存明细与输出 token 字段；费用应按端点价格核对，不能看到字段就假定收费。[请求与返回参考](https://developers.openai.com/api/reference/resources/decisions/methods/create)。

官方指南要求 SDK 至少为 Python 3.26.0、JavaScript 7.30.0、Go 3.73.0、Ruby 0.101.0 或 Java 4.78.0。JS／Python 文档均提供 `client.decisions.create`；这是公开 SDK 契约，本文没有安装或验证本地版本。[Decisions SDK 要求](https://developers.openai.com/api/docs/guides/decisions)、[JavaScript 参考](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create)、[Python 参考](https://developers.openai.com/api/reference/python/resources/decisions/methods/create)。

## 4. 价格与访问限制

| 路径 | 当前公布的基础文本 token 价格，每百万 token | 对本轮比较的意义 |
| --- | --- | --- |
| Decisions + `gpt-6-luna` | 输入 $0.10；无缓存读取、缓存写入或输出费用 | 专门端点价格，不套用 Responses 输出价 |
| Responses + `gpt-6-luna`，Standard、短上下文 | 输入 $0.10；缓存输入 $0.01；缓存写入 $0.125；输出 $0.50 | 通用生成路线，需统计实际输出与推理用量 |
| TypeSafe Jev 1.13 | 输入 $0.042；输出免费 | 文字路线；图像转成描述的费用另计 |

来源：[Decisions 定价](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability)、[GPT-6 Luna 价格](https://developers.openai.com/api/docs/models/gpt-6-luna)、[TypeSafe Models](https://docs.typesafe.ai/models)。Decisions 仍适用区域处理溢价与长上下文倍率。Luna 模型页当前给出超过 272k 输入 token 时输入价 2 倍、区域处理加 10%；它不承诺 Decisions 支持该模型所有通用功能。

输入价格不是每图价格，也不是每次判断价格。应记录实际图像输入用量、文字／描述准备与重试成本；两家相同文本不一定有相同 token 数。普通视觉指南的图片数量、URL 和 file ID 能力不能移植到 Decisions；该端点的 128 张与 data URL 要求优先。[图像指南](https://developers.openai.com/api/docs/guides/images-vision)、[Decisions 输入参考](https://developers.openai.com/api/reference/resources/decisions/methods/create)。

当前 Decisions 指南／参考未明确列出每次问题数、Choice 选项数、Score 等级数及该端点独立的上下文上限；缺少数字不代表无限制。组织与项目额度应查 Platform 的 Limits，不能将普通模型页的吞吐表直接视为 Decisions 的实测或专项保证。[限流指南](https://developers.openai.com/api/docs/guides/rate-limits)。

Jev 当前文档给出 64k 总请求预算、`state` 加最长问题不超过 32k；Choice 最多 255 项、Score 最多 10 级。当前 100k token/s、80 请求/s 的限流会动态调整。对于少量即时问题，这些是输入和失败处理边界，不是要求把请求塞满的理由。[TypeSafe Models](https://docs.typesafe.ai/models)、[TypeSafe API](https://docs.typesafe.ai/api)。

## 5. 隐私、安全返回与视觉边界

OpenAI 的 `/v1/decisions` 默认不用于训练，主动共享数据另有约定；滥用监控日志通常保留最多 30 天，符合条件的客户可使用 ZDR。GPU 本地缓存状态可能存在至 24 小时，图像若被判为潜在 CSAM 可保留人工复核，ZDR 也有此例外。HIPAA 需相应协议与账户配置。该端点支持区域存储，区域推理在美国及欧洲（EEA + 瑞士）；地区可用不等于推理在该地区完成。[Decisions 数据控制](https://developers.openai.com/api/docs/guides/your-data)。

TypeSafe 承诺不以客户请求与回答训练 Jev，企业 ZDR 需联系销售；其普通隐私政策以业务所需期限保留个人数据，没有给所有账户统一的请求删除天数。两家的“不训练”均不能简写成“不保存”。[TypeSafe Models](https://docs.typesafe.ai/models)、[TypeSafe Legal](https://docs.typesafe.ai/legal)、[隐私政策](https://typesafe.ai/legal/privacy-policy)。

接口支持图像和拒答，不证明某类成人绘画一定接受、一定拒绝或能准确分级。本文没有验证这类行为。对 Kinshoko 的实验，图像发送范围应单独定义；现有 ADR 的查找词与标签名发送约定不是图像上传规格。

视觉指南仍列出精确空间定位、小文字、部分非拉丁文本、计数等局限。直接看图能提供视觉证据，不能保证像素级裁切、位置与局部细节判断。`low` 也不总比 `high` 少 token；缩放、detail 与费用按所选模型验证。[视觉限制与 detail](https://developers.openai.com/api/docs/guides/images-vision)。

Jev 1.13 官方还承认干扰状态、注入式内容、复杂间接推理与选项顺序可影响判断。类型正确不等于语义正确；不能因它不生成任意文字，就将其视为能可靠防注入的边界。[Jev 1.13 已知局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)。OpenAI 的拒答机制也不是业务判断正确的证据。

## 6. 与 Jev 和 Responses 的实质差别

| 比较项 | TypeSafe Jev | OpenAI Decisions | Responses + Structured Outputs |
| --- | --- | --- | --- |
| 输入证据 | 文字或结构化 JSON 状态 | 原生文字与图片 | 支持视觉的模型可直接接收图片 |
| 决策契约 | `state`，问题／答案 map；Noul、Choice、Score | `input`，问题／答案有序数组；Predicate、Choice、Score | 生成符合应用 JSON schema 的对象 |
| 选项及分值 | `criteria`；概率 map，Score 含 `legend` | `choices`／`levels`；概率数组 | 可生成枚举、解释或提取字段；自定义概率字段无专门统计保证 |
| 扩展能力 | 固定答案空间，不生成任意文字 | 专门三原语及拒答 | 任意受支持 schema、文字解释、工具调用等 |
| 本轮优先位置 | 已有文字足够的即时判断 | 必须看图的一步有限判断 | 需要解释、生成或较复杂推理的对照路径 |

契约来源：[TypeSafe API](https://docs.typesafe.ai/api)、[Decisions Reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)、[Responses Reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。最后一行是适配推论，不是模型质量排名。

Jev 的 `noul` 与 Decisions 的 `predicate` 概念相近，字段、输入结构、选项描述、概率容器和拒答分支均不同；不能只替换 base URL 迁移。Jev 当前明确不收图像、音频或视频；把它接在图像描述后面，取得的是描述中的证据，描述没记下的遮挡和线条信息无法恢复。[TypeSafe State](https://docs.typesafe.ai/concepts/state)。

Responses 可以使用 `text.format` 的 `json_schema` 与 `strict: true`，适合需要额外字段或解释的请求。Schema 约束仍可能返回语义错误，拒答或不完整生成需单独处理；自行写一个 `confidence` 字段不等于 Decisions 或 Jev 的概率语义。[Structured Outputs 指南](https://developers.openai.com/api/docs/guides/structured-outputs)。Luna 在通用接口上支持的 reasoning 配置、流式或工具能力，也不自动出现在 Decisions 的请求契约里。

## 7. 对 Kinshoko 的适配推论

沿用 [领域词汇](../../GLOSSARY.md) 与 [Jev 的即时判断定位](jev-community-use-cases.md)，先判断问题需要哪种证据。

| 证据与任务 | 合适的研究路径 |
| --- | --- |
| 已知标签、别名、坐标和明确操作 | 机械规则与已有识别结果，维持基础交互 |
| 文字及应用状态已足够 | Jev／Decisions 的文字判断可以比较；无须额外上传图片 |
| 两个现有候选局部与当前参考目的 | 用图文 Choice 比较“哪个更容易看清刘海走向”；只影响当次建议 |
| 像素级裁切、原图身份、保存后引用及成员布局 | 专门识别、坐标计算与明确保存规则；小判断不能保证这些事实 |

多模态的增量在于直接查看与当前问题相关的局部，而不是提前替所有参考图生成描述。该选择应浅而短；用户能忽略建议或查看另一个候选。只要纠错与等待吞掉收益，即使模型经常答对也不适合这个位置。

应用先给出基础结果，将请求关联到当次查询、参考图与裁切版本；输入变更后丢弃迟到答案。`unknown`、低分、拒答、限流和超时都可以让这一步保留基础结果，但日志应区分原因。无需每次自动升级到更重模型，也不应让模型改写人工标签决定或已保存的参考组布局。

## 8. 最小实验：先验证一个即时视觉选择

选择上文“两个候选局部哪个更便于观察刘海走向”作为单一问题。固定当前用途、候选顺序、局部与输出空间 A／B／无法判断，另用交换顺序的样本检查位置偏差；不同时要求定位、解释、打标签或操作布局。

比较以下路径，记录各自实际看到了哪些证据：

1. 基础结果及已有标签／文字判断。
2. 临时视觉描述 → Jev；另列已有描述缓存的情况。
3. Decisions + `gpt-6-luna`，直接接收相同局部。
4. Responses + 同一 `gpt-6-luna`、短枚举 Structured Outputs；固定 reasoning 设置。
5. 只有确有必要时，再加入较重视觉模型作质量参照。

这是实验提案，不是已实现的工作流。文字材料欠缺视觉信息，应记录为证据差异；描述准备的时间与费用须计入串行路线。同模型的 Decisions／Responses 对照有助于观察接口收益，但不意味着底层计算或结果分布相同。

测量完整交互：局部准备、编码／上传、服务处理、结果应用。记录 P50／P95、有效期内完成比例、实际 token 与费用、选择错误、业务弃权、拒答、超时，以及画师忽略或纠正所花时间。概率可用有明确标注的样本检查校准；主观参考目的存在分歧时，保留分歧，不捏造唯一正确答案。

以找到合适参考所需时间和可恢复的错误代价判断是否保留该步骤。**实验尚未开展，中文表现、绘画参考判断、概率校准、成人内容处理及端到端收益均未验证。** Public beta 让直接实验成为可能，没有替代这些验证，也没有改变现有首版范围。
