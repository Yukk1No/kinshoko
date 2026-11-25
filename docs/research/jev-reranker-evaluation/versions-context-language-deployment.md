# 版本、上下文、语言与部署

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

---

返回：[《Jev 与候选用途判断：Kinshoko 适用性评估》索引](../jev-reranker-evaluation.md)。
