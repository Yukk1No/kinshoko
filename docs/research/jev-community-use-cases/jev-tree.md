# 2. jev-tree：在已定义的分类层级里选择

**已核查的调用。** 默认真实 evaluator 通过 Vercel AI Gateway 的 `experimental_evaluate` 调用 `model: 'typesafe-ai/jev'`，questions 中使用 Choice。state 来自调用者的文本或序列化数据，默认处理器会遮蔽部分秘密与邮箱并限制到 8,000 个字符；criteria 来自当前层候选节点的 label、description，以临时键映射回原节点。代码请求 Gateway 的 `zeroDataRetention: true`，这只能证明请求配置，不能单靠源码确认实际服务端保留行为。[核心调用、state 处理与遍历代码](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/index.ts)。

**结果如何改变流程。** 每次 Choice 选中一个分支，程序再在这个分支内继续选择，最终返回已有叶节点的 ID、value 和路径。超过单次候选上限时会先分桶再递归选择，默认每组 32 项，上限 255；超时、调用预算耗尽等情况返回 `unavailable`。选择不生成分类或标签。项目记录的是所选选项的概率；它没有“概率太低就拒选”的门槛，也没有内置“以上都不适合”。CLI 默认跑离线演示 evaluator，显式 `--live` 才走实际模型调用。[README](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/README.md)、[Choice 与终止条件](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/index.ts)、[离线与真实模式](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/cli.ts)。

**对 Kinshoko 的初步推论。** 缩小候选空间可参考，但逐层调用会延长整条路径，批量名称映射也没有明显的即时性收益。更接近发起者原则的变体是：用户正在输入一个含糊短语时，在一小组已有候选中挑选临时补全；不自动建立别名或改写标签。已知名称与别名仍由代码匹配，标签无需因此建成树。仅依据文字映射名称，也不能被当作已经根据参考图内容提出的自动标签建议。

**能力边界。** 这是一次选择一个叶节点，不能直接承担参考图的多标签标注或自动合并标签别名。逐层选择是贪心过程，早期分支选错后不会检查其他分支；超宽候选按原有顺序分桶，桶描述只是首尾标签，不等于精心设计的语义分类。最终记录的概率也不是整条路径的校准准确率。若用于标签建议，需要另加“不匹配”、复核与撤销的流程。[对应实现](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/index.ts)。

---

返回：[《Jev 社区应用：Kinshoko 在重排之外的使用机会》索引](../jev-community-use-cases.md)。
