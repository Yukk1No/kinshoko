# 可以借鉴的接口思路与尚未证实的事项

TypeSafe 自己发布了 MIT 的 `system-one-adapter-python`：保留 Choice／Score／Noul 风格的接口，改用普通 LLM 后端，并支持自定义 OpenAI-compatible endpoint。这是把“结构化、狭窄判断交给模型，流程与计算交给代码”与 Jev 服务分开比较的一手例子；**兼容接口和把概率归一化，不证明后端已具备 Jev 宣称的校准、速度或准确率。**本次未安装或运行适配器。[官方适配器 README](https://github.com/typesafe-ai/system-one-adapter-python)、[LICENSE](https://github.com/typesafe-ai/system-one-adapter-python/blob/main/LICENSE)

官方 Jev 1.13 资料承认字面理解、数值精度、间接推理、无关长状态和对抗内容的边界，也明确不保证跨原语或正反问题的数学一致性。受限答案结构能减少格式或选项空间错误，仍会有语义误判；“不能幻觉”的宣传不能等同于“检索判断不会错”。[已知失效模式](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

仍未证实：模型参数与完整架构／训练细节、Jev 权重再分发许可、私有部署可行性、服务版本长期保留与 SLA、中文／日文目标领域的概率校准、参考图元数据上传的实际服务行为，以及 Kinshoko 用户找到合适参考的时间是否缩短。公开 API 可调用与官方性能声明均不代表本项目已评测或已选型。

---

返回：[《Jev 与候选用途判断：Kinshoko 适用性评估》索引](../jev-reranker-evaluation.md)。
