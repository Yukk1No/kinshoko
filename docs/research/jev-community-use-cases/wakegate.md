# 7. wakegate：决定事件是否值得打断当前工作

**已核查的调用与流程。** 库通过 `experimental_evaluate` 调用 `typesafe-ai/jev`，输入代理等待的目标与新事件／观察，Choice 候选为 wake、not_yet、unrelated。应用读取 wake 概率决定是否唤醒。用户消息、没有可供评估的事件、连续跳过次数达到上限会直接唤醒；模型超时或失败也唤醒。README 中的 21/21 是作者小规模手工案例结果，不能当作普适准确率或节省成本的实测。[项目说明及案例说明](https://github.com/shitianfang/wakegate/blob/3a50a9e979943a3e77850f0364d8d80404124a7c/README.md)、[完整模型调用与绕过条件](https://github.com/shitianfang/wakegate/blob/3a50a9e979943a3e77850f0364d8d80404124a7c/src/index.ts)。

**对 Kinshoko 的修正推论。** 这比批量审核更接近目标模式：在事件到来时，迅速判断它是否与当前目的有关、是否值得启动较重的语义处理。模型只回答一个门控问题，不承担后续推理。是否进入昂贵处理的误判成本要分别估计；用户明确请求的处理不应被错误门控静默吞掉。固定完成／失败事件仍用规则，同步冲突、原图损坏、备份失败仍明确展示。Kinshoko 尚无需要这样门控的复杂事件流，不能为了引入 Jev 新增后台代理。

---

返回：[《Jev 社区应用：Kinshoko 在重排之外的使用机会》索引](../jev-community-use-cases.md)。
