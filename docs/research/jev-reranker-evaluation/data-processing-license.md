# 数据处理与许可

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

---

返回：[《Jev 与候选用途判断：Kinshoko 适用性评估》索引](../jev-reranker-evaluation.md)。
