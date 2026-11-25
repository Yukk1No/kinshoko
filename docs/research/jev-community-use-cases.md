# Jev 社区应用：Kinshoko 在重排之外的使用机会

初次调研：2026-10-01；补充更新：2026-10-07。七个社区项目的调用记录仍固定在初次核查提交，本次没有重新运行或全面复查这些项目。

本轮核查七个真实接入 Jev 的社区项目，覆盖语义审核、层级分类、批量整理、画布操作、分项评价、工具推荐和事件分流。项目由 [awesome-jev-cobanov](https://github.com/hotchpotch/awesome-jev-cobanov) 发现，下面的事实依据各项目自己的 README 和调用代码。引用固定到本轮读取的提交；只核查代码，没有运行项目、调用 Jev 或复现作者的效果与性能。它们是能力与流程的参考，不构成 Kinshoko 的模型选择或领域共识。

**2026-10-07 补充：OpenAI Decisions API 已于 10 月 6 日发布 beta，当前支持文字与图像输入及专门的判断原语。**因此，从这些项目借鉴“小判断”的职责，不再意味着优先采用“视觉模型生成描述 → Jev”的串行链路。判断需要画面证据时，新增直接多模态后端作为比较候选；判断仅需文字或应用状态时，Jev 仍可比较。接口、费用、概率与拒绝处理见[多模态小判断核查](multimodal-decisions-evaluation.md)。这是研究方向；[首版规格 #42](https://github.com/Yukk1No/kinshoko/issues/42)中的本地范围与[ADR-0003](../adr/0003-tag-identity-and-approximate-search.md)中的 roadmap 位置沿用现有决定。[OpenAI 发布记录](https://developers.openai.com/api/docs/changelog)、[Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)

**按发起者反馈修正评估标准：Jev 应承担需要及时响应的局部语义判断，处在纯机械规则与较重模型之间。** 不能以高正确率为设计前提；价值要来自缩短等待，以及误判后仍容易继续操作。上一版优先推荐批量分类、审核和整理，只考虑了“能否表达为结构化判断”，没有说明这些任务为何需要这种响应速度，现撤回该优先级。

按这一标准，最值得借鉴的是 jev-canvas 的命令与完整性判断、wakegate 的语义唤醒判断，以及 skillbox 在有限目录中的即时建议。具体能否用于 Kinshoko，取决于是否出现规则处理不了、用户又等不起复杂推理的交互点。下文七个项目的源码事实保留；对应的 Kinshoko 用途都是提案，其适用性以下方修订后的优先顺序为准。模型端和网络端的实际延迟、中文误判率尚未实测。

| 项目 | 核查提交 | 真实 Jev 输出原语 | 输出参与的流程 |
| --- | --- | --- | --- |
| [zod-jev](https://github.com/jomatsu/zod-jev) | `700bd256` | Noul，逐条语义规则的 yes 概率 | 通过、拒绝、不确定、服务不可用；由应用决定发布或复核 |
| [jev-tree](https://github.com/reachjalil/jev-tree) | `95bff63b` | Choice，在每层候选中选择一个 | 沿既定分类树走到一个叶节点，返回路径及选择记录 |
| [jev-curate](https://github.com/AkashPriyadarshii/jev-curate) | `837478ef` | 当前预设实际使用 Noul、Score | 用阈值筛选文本记录，输出通过与拒绝的数据文件 |
| [jev-canvas](https://github.com/gaborishka/jev-canvas) | `cec7b27a` | Noul、Choice、Score | 从语音转录与画布状态选择操作、对象、位置及尺寸档位，由代码执行 |
| [Vibe Check for X](https://github.com/RafalWilinski/vibecheck) | `d834d501` | 可配置的 Score、Noul、Choice | 分项评价帖子草稿；媒体先由另一视觉模型描述，Jev 读取描述 |
| [skillbox](https://github.com/kitze/skillbox) | `cda64ad3` | Score，对有限技能目录逐项评分 | 按任务推荐既有技能，无匹配与模型不可用分别处理 |
| [wakegate](https://github.com/shitianfang/wakegate) | `3a50a9e9` | Choice：wake、not_yet、unrelated | 判断事件是否值得唤醒等待中的代理，减少无关事件打断 |

## 分篇

### 社区项目核查

- [zod-jev：把结构合法与语义合理分开](jev-community-use-cases/zod-jev.md)：结构校验、语义规则与待复核流程。
- [jev-tree：在已定义的分类层级里选择](jev-community-use-cases/jev-tree.md)：沿固定分类树逐层选择的实现。
- [jev-curate：把多个小判断组合成批量筛选](jev-community-use-cases/jev-curate.md)：Noul / Score 组合与批量数据筛选。
- [jev-canvas：自然语言选操作，应用计算布局](jev-community-use-cases/jev-canvas.md)：命令理解、对象选择与布局计算分工。
- [Vibe Check for X：按多个标准评价，视觉证据另行提供](jev-community-use-cases/vibe-check-for-x.md)：分项评价与视觉描述串行链路。
- [skillbox：根据当前任务推荐已有工具](jev-community-use-cases/skillbox.md)：有限目录内的即时工具推荐。
- [wakegate：决定事件是否值得打断当前工作](jev-community-use-cases/wakegate.md)：事件分流与语义唤醒判断。

### 对 Kinshoko 的判断

- [在 Kinshoko 中的优先顺序](jev-community-use-cases/kinshoko-priorities.md)：修订后的用途优先级与原因。
- [对当前建模的具体启发](jev-community-use-cases/modeling-implications.md)：职责边界、状态保存与错误处理启发。
- [如何以小实验验证，而不是凭社区热度选型](jev-community-use-cases/small-experiments.md)：小样本、延迟与误判成本验证方法。
