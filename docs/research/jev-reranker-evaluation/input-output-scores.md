# 输入、输出与分数含义

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

---

返回：[《Jev 与候选用途判断：Kinshoko 适用性评估》索引](../jev-reranker-evaluation.md)。
