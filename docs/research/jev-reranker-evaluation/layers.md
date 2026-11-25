# Jev 与 reranker 是不同层次

Jev 是 TypeSafe 的通用文本决策模型，输入一份 `state` 和多个预先定义答案空间的问题，返回有类型的判断与概率。官方明确说明它不生成回复、代码或推理解释；当前只接受文本、JSON 对象和数组，不接受图像、音频或视频。[System One](https://docs.typesafe.ai/concepts/system-one)、[State](https://docs.typesafe.ai/concepts/state)

`hotchpotch/jev-reranker` 是第三方 Python 封装：输入文字查询与候选文档，调用 Jev API 得分，再排序或按阈值过滤。它不是新训练的图像模型，也不是可下载的 Jev 权重。作者把用途放在检索之后、RAG 组装上下文之前；基础包需要 Python 3.11+ 和 TypeSafe API key。[作者 README](https://github.com/hotchpotch/jev-reranker)

**接口边界推论：**对 Kinshoko 直接送参考图做发型识别，目前没有 Jev 接口支持。若先把参考图转换成标签、备注或描述，再做文字判断，Jev 判断的是这些文字所表达的信息；不能凭这种接入自动获得文字中缺失的视觉事实。

---

返回：[《Jev 与候选用途判断：Kinshoko 适用性评估》索引](../jev-reranker-evaluation.md)。
