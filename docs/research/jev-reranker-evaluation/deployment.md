# 部署与服务边界

[← 返回索引](../jev-reranker-evaluation.md)

## 版本、上下文、语言与部署

以下模型规格、输入边界、别名与限制已于 2026-10-07 复核；服务限制可能随后变化。[Models](https://docs.typesafe.ai/models)

| 项目 | 已核实的公开声明 |
| --- | --- |
| 当前版本 | `jev-1.13.0`；`jev-latest` 与 `jev-preview` 当前都指向它。 |
| 版本固定 | 可直接指定版本 ID；别名会移动，回复中的 `model` 可记录实际版本。未核实旧版本保留期限。 |
| 总上下文 | 每次请求 64k token，涵盖 `state` 和所有问题；`state` 加最长单个问题另受 32k token 限制。 |
| 多问题 | 同一状态下各问题独立并行评价；官方建议合并调用，但这不等于无限候选或无批次效应。[并行模式](https://docs.typesafe.ai/patterns/fan-out) |
| 中文／日文 | 英文是主训练语言且当前准确度最好；官方称包括 CJK 在内的其他语言可接受，但准确度较低。未找到中文、日文或中日英混合标签的分项成绩。[State](https://docs.typesafe.ai/concepts/state) |
| 专属训练 | 官方称各账户共享相同权重，不提供用客户数据做 Jev fine-tuning／LoRA 的方式；领域规则经请求传入。 |

**已证实的公开接入路径是云 API。**官方 JS 客户端 `v0.6.0` 的 `systemOne()` 发起 HTTP POST；SDK 公开不等于模型公开。本次在官方模型页、文档索引与官方仓库中没有找到 Jev 权重、本地推理服务或离线部署说明。VPC／私有云／企业专属部署也未找到明确承诺，不能写成已支持或永久不支持；官方明确提供的企业能力是更高配额与另议的数据处理方案。[固定 JS 客户端](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts)、[官方仓库](https://github.com/typesafe-ai)、[文档索引](https://docs.typesafe.ai/llms.txt)

Python 官方包为 `typesafe-sdk`，有同步／异步客户端；JS／TS 包为 `@typesafe-ai/sdk`，文档要求 Node.js 20+。两者默认处理重试，HTTP 接口可由其他语言调用；这不决定 Kinshoko 必须采用哪种技术栈。[Python SDK](https://docs.typesafe.ai/sdk/python)、[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[SDK 总览](https://docs.typesafe.ai/sdk)

## 费用、延迟与吞吐

截至 2026-10-07，标价仍为 **每百万输入 token 0.042 美元**，输出 token 免费；当前限额为 100K token／秒与 **80 请求／秒**（旧稿的 40 已更新）。官方注明限额动态调整且可能不预告变化，超限返回 429。[Models 定价与限制](https://docs.typesafe.ai/models)

按此单价计算，累计 10,000 输入 token 为 0.00042 美元，1,000 次这样的请求为 0.42 美元。这只是算术示例，不是一次 Kinshoko 搜索的预算；实际费用取决于状态、问题、rubric、候选数、拆批和重试的总 token。低单价使有限试验有价值，不能仅凭“收费 API”否定方案。

厂商发布文章自报端到端 70–500 ms，并强调并行采样与 RLCD。这不是本项目用户所在地、候选长度与负载下的延迟保证；本次未测网络 RTT、P50／P95／P99、持续并发、重试和全量候选的耗时。[官方发布文章](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

官方工作流评测以四种自动化任务为例，参考标签来自两个大模型的结果共识，并假定 harness 正确。它可以说明厂商测试的方法和任务形状，不能代替画师确认的参考图检索标注，也不能据此断言中文绘画任务有相同收益。[官方评测方法](https://evals.typesafe.ai/)

## 数据处理与许可

| 事项 | 公开条款与证据边界 |
| --- | --- |
| 输入上传 | 云调用把请求文本交给 TypeSafe。隐私政策称收集 prompts、data、instructions 等 Input，服务托管在美国。[隐私政策](https://typesafe.ai/legal/privacy-policy) |
| 模型训练 | 官方 Models 称不以客户请求／回复训练；隐私政策承诺不以 Input 训练或微调。MCA §4.1 的合同措辞是未经客户事先同意不把 Customer Data 纳入修改模型权重的训练集。[Models](https://docs.typesafe.ai/models)、[隐私政策](https://typesafe.ai/legal/privacy-policy)、[MCA](https://typesafe.ai/legal/mca) |
| 普通保留 | 隐私政策与 DPA 使用“达到处理目的所需时间”等条件，没有固定的 0／7／30 天保证。不能把“不训练”理解为“不留存”。[隐私政策 Retention](https://typesafe.ai/legal/privacy-policy)、[DPA Schedule I](https://typesafe.ai/legal/data-processing) |
| 零保留 | 文档称企业客户可另议 ZDR；本次未取得其覆盖字段、例外、删除时间和价格。[Legal](https://docs.typesafe.ai/legal) |
| 其他处理 | MCA §4.1／4.3 涉及计费、滥用监测、法定义务及 telemetry；telemetry 包括技术日志、哈希、统计与分类，可用于改善服务。公开条款不等于本次审计了真实服务器行为。[MCA](https://typesafe.ai/legal/mca) |
| 软件许可 | 官方 Python SDK、JS SDK 与作者 reranker 仓库声明 MIT；该软件许可不能替代 Jev 服务条款或授予模型权重许可。[Python LICENSE](https://github.com/typesafe-ai/typesafe-sdk-python/blob/main/LICENSE)、[JS v0.6.0 LICENSE](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/LICENSE)、[reranker 仓库](https://github.com/hotchpotch/jev-reranker) |
| 服务许可 | MCA §2.2 允许在客户应用中集成 API；§2.3 对转售服务、用服务／输出蒸馏或训练模仿模型等另设限制。若未来涉及训练数据生产，应先核对实际适用协议。本段只是条款摘记。[MCA](https://typesafe.ai/legal/mca) |

上述政策适用于 TypeSafe 直连。本次没有审查代理供应商的处理条款，不能把直连承诺自动套给第三方网关。条款版本：隐私政策 2025-11-19、DPA 2026-04-24、MCA 2026-09-23。
