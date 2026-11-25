# 原文的实验能证明什么

作者报告的是 `jev-1.13.0` 在 NanoHotpotQA 的 50 个英文问答查询、每次 100 个混合检索候选上的结果；两种 Jev 方法都用 listwise 评分。以下是作者自报，本次未复现。[原文实验](https://huggingface.co/blog/hotchpotch/introducing-jev-reranker)

| 方法 | nDCG@10 | 每次平均保留候选 |
| --- | --- | --- |
| 原始混合检索 | 0.833 | 100 |
| 普通 rerank | 0.969 | 100 |
| relevance filtering，阈值 0.2 | 0.975 | 7.62 |

候选池里的 97 个已标注正例全部保留，另有 3 个正例在重排前就未进入候选池。约 92% 的候选被过滤，只能支持这个实验设置中的保留规模和排序成绩；没有覆盖二次元图片、中文绘画查询或最终找图时间。作者对下游幻觉减少的描述是预期，未做生成效果测量；0.975 与 0.969 的差异也没有附统计不确定性。[原文结果与边界](https://huggingface.co/blog/hotchpotch/introducing-jev-reranker)

需要借鉴的是两个独立问题：**谁应该排在前面**，以及**哪些候选值得交给下一步使用**。源码的 relevance preset 对没有可用问答证据的内容压低分数，并通过文字指令设置分数锚点；这些锚点不会强制变换或校准返回分数。默认标准是回答问题所需的事实，我们若接入，需要把判断标准改成画师的参考目的，并重新验证阈值。[实际指令](https://github.com/hotchpotch/jev-reranker/blob/main/src/jev_reranker/instructions.py)

评测指南还揭示两个容易误读的地方：过滤在候选全部评分之后执行，因此不会省掉这次评分本身的调用；脚本的 `--top-k 10` 会利用标注补齐正例，它测的是受控候选上的重排。默认完整候选模式则保留原候选池，记录召回缺失。我们应分别测初筛漏图和重排漏图，实验中也应单列空结果。[评测协议](https://github.com/hotchpotch/jev-reranker/blob/main/docs/eval.md)

以上第三方代码读取的是研究日的 `main`，未取得不可变提交 ID，不能视为与博客发表时逐字相同的版本。公开 `pyproject.toml` 当次显示包版本 `0.1.2`，正式实验应固定完整提交、实际包版本、模型 ID、指令、批次划分与样本。[包元数据](https://github.com/hotchpotch/jev-reranker/blob/main/pyproject.toml)

---

返回：[《Jev 与候选用途判断：Kinshoko 适用性评估》索引](../jev-reranker-evaluation.md)。
