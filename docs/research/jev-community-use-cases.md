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

## 1. zod-jev：把结构合法与语义合理分开

**已核查的调用。** 库先让 Zod 检查数据结构，再对调用者提供的语义规则调用 TypeSafe SDK 的 `systemOne`。发送的 state 是 `{ value, context? }`，questions 中每条规则都是 Noul，含自然语言 instructions 和 criteria。Jev 返回 yes 概率，通过的规则不添加问题记录，其余映射为 `rejected`、`uncertain`；没有有效答案或可重试的服务故障映射为 `unavailable`。默认阈值为 0.95：大于等于 0.95 通过，小于等于 0.05 拒绝，中间保留为不确定。这个阈值是库的决策配置，不是其正确率保证。[README](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/README.md)、[真实 SDK 调用与判定](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/src/judge.ts)、[Zod 接入](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/src/semantic.ts)。

**结果如何改变流程。** 项目自己的日文出品 demo 将标题、说明、分类、状态、价格作为 value，将指南和价格参考作为 context，审核分类与文本是否一致、说明是否充分等六项条件。字段格式先由代码检查；格式不合法时不调用模型。demo 支持 off、shadow、enforce：shadow 记录判断但继续原流程；enforce 对明确否定拒绝提交，对 `uncertain` 或 `unavailable` 接受为待复核状态。裸库的语义 parse 会把不确定、不可用也当作校验问题，待复核行为来自 demo 应用的明确分支。[出品 demo 的状态与提交逻辑](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/web/listing.ts)、[另一份分阶段接入示例](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/adoption/intake.ts)。

**对 Kinshoko 的初步推论。** 结构检查与语义检查分开的形式可参考，但批量导入审核本身没有强即时性要求，不能据此优先选用 Jev。若以后存在用户输入备注时的即时轻提示，可以研究一个局部语义问题；结果只影响当次提示，不阻止提交或改变长期元数据。确定性的字段、路径和格式检查交给代码，图片内容真值也不能由文字审核裁定。

**能力边界。** demo 的照片上传是展示功能，state 明确排除照片，项目没有验证 Jev 的视觉理解。日文规则与示例证明作者使用了日文输入，不能证明其日文准确率，更不能外推中文绘画标签的效果。文本一致性判断也不能证明参考图确实包含所述内容；阈值及规则需要结合自己的样本检验。[demo 说明](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/web/README.md)、[state 构造](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/web/listing.ts)。

## 2. jev-tree：在已定义的分类层级里选择

**已核查的调用。** 默认真实 evaluator 通过 Vercel AI Gateway 的 `experimental_evaluate` 调用 `model: 'typesafe-ai/jev'`，questions 中使用 Choice。state 来自调用者的文本或序列化数据，默认处理器会遮蔽部分秘密与邮箱并限制到 8,000 个字符；criteria 来自当前层候选节点的 label、description，以临时键映射回原节点。代码请求 Gateway 的 `zeroDataRetention: true`，这只能证明请求配置，不能单靠源码确认实际服务端保留行为。[核心调用、state 处理与遍历代码](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/index.ts)。

**结果如何改变流程。** 每次 Choice 选中一个分支，程序再在这个分支内继续选择，最终返回已有叶节点的 ID、value 和路径。超过单次候选上限时会先分桶再递归选择，默认每组 32 项，上限 255；超时、调用预算耗尽等情况返回 `unavailable`。选择不生成分类或标签。项目记录的是所选选项的概率；它没有“概率太低就拒选”的门槛，也没有内置“以上都不适合”。CLI 默认跑离线演示 evaluator，显式 `--live` 才走实际模型调用。[README](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/README.md)、[Choice 与终止条件](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/index.ts)、[离线与真实模式](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/cli.ts)。

**对 Kinshoko 的初步推论。** 缩小候选空间可参考，但逐层调用会延长整条路径，批量名称映射也没有明显的即时性收益。更接近发起者原则的变体是：用户正在输入一个含糊短语时，在一小组已有候选中挑选临时补全；不自动建立别名或改写标签。已知名称与别名仍由代码匹配，标签无需因此建成树。仅依据文字映射名称，也不能被当作已经根据参考图内容提出的自动标签建议。

**能力边界。** 这是一次选择一个叶节点，不能直接承担参考图的多标签标注或自动合并标签别名。逐层选择是贪心过程，早期分支选错后不会检查其他分支；超宽候选按原有顺序分桶，桶描述只是首尾标签，不等于精心设计的语义分类。最终记录的概率也不是整条路径的校准准确率。若用于标签建议，需要另加“不匹配”、复核与撤销的流程。[对应实现](https://github.com/reachjalil/jev-tree/blob/95bff63bd653fee4dc71f33f9431dce0f81e2ca3/src/index.ts)。

## 3. jev-curate：把多个小判断组合成批量筛选

**已核查的调用。** Rust 客户端向 `https://api.typesafe.ai/v1/systemone` 发送 HTTP 请求，源码固定 `model: 'jev-1.13.0'`。每条记录先做文本清理与空白、过短等检查，再以 `{ text: clean_text }` 为 state，一次请求发送一组问题。当前三个预设使用 Noul 检查循环论证、奉承、免责声明、代码占位等现象，用 Score 按五档 criteria 判断推理深度或代码质量。虽然类型可表达 Choice，现成预设及筛选流程没有据 Choice 给数据分组。[API 客户端](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/client.rs)、[预设问题与阈值](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/presets.rs)、[预检查与模型调用](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/filter.rs)。

**结果如何改变流程。** Noul 超过拒绝阈值或 Score 低于最低档位时，记录被放到 rejected；其余进入 clean。调用失败、缺失答案也被放到 rejected，附原因。JSONL 路径保留原始行，拒绝文件另存理由；执行路径没有把各题概率、分数、模型使用信息一起写入输出文件。README 的 24 rows/s 来自本地 mock benchmark，不能作为真实 Jev 吞吐证据。[筛选判定](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/filter.rs)、[任务与输出调用](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/main.rs)、[输出文件实现](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/parquet_io.rs)、[README 的 benchmark 注释](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/README.md)。

**对 Kinshoko 的修正判断。** 批量整理可以用许多处理方式，速度与价格也可能有意义，但它不能说明为何要在实时交互中使用小判断模型。故不再把该项目对应的整理功能列为本次优先验证方向。可保留预检查、保全原始数据和区分调用失败的工程经验；它们本身并不要求 Jev。

**能力边界。** 预设面向数学、代码等文本训练集，不能原样解释绘画参考的价值。源码实际先把数据集读进内存，不能仅凭 README 当作已验证的流式导入器；Parquet 路径只取选中的文本列，其他列未写回，不能直接用于保留完整参考图元数据。它提供的是可借鉴的筛选结构，完整导入、原始记录保全及复核状态仍需另行设计。[数据读取与列选择](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/parquet_io.rs)、[批量执行](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/main.rs)。

## 4. jev-canvas：自然语言选操作，应用计算布局

**已核查的调用与流程。** 项目结合 tldraw、浏览器语音转录和手部指向。服务器通过 OpenRouter 的 decisions 接口调用 `typesafe/jev-1.13`。state 包含转录文本、形状的短 ID、类别、颜色、坐标、尺寸、选中状态和视口；手部识别提供的是指向坐标，Jev 没有收到摄像头画面。Noul 判断是否为命令及是否完整，Choice 选择 create、move、delete、recolor、resize 等操作和已有目标，Score 选择尺寸档位。当前构造器限制转录到 300 字符、形状到 40 个。[项目说明](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/README.md)、[真实 API 调用](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/server/decide.js)、[state 与问题构造](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/shared/questions.js)。

模型答案经过独立 policy：检查命令、完整度、目标等概率，返回执行、等待或忽略；位置和缩放由代码算，目标缺失时也会尝试指向、唯一对象或选中对象等明确上下文。源码中的删除和清空同样可以成为执行命令，不能把其策略直接搬到本项目。[答案处理与几何计算](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/shared/policy.js)。

**对 Kinshoko 的修正推论。** 更值得借鉴的是即时交互中的小判断：在已有自然语言或语音入口时，判断一句话是否还没说完，或在少量已知操作／目标中解释“这张再近一点”。明确目标及操作仍可直接由规则处理；模型仅补足其中的语义歧义。错误只应影响可取消的提示、操作预览或可撤销的显示变化。不能因为社区示例就决定新增语音功能。操作目标使用成员 ID，返回后验证状态；结果若已过交互期限或用户已改变选择就丢弃。它也不证明模型能定位眼睛，局部区域仍需已知坐标或图像识别能力。

## 5. Vibe Check for X：按多个标准评价，视觉证据另行提供

**已核查的调用与流程。** 浏览器扩展将帖子草稿、回复上下文和选中的 rubrics 发给 TypeSafe `systemone`，使用 `jev-latest`。rubrics 可以分别产生 Score、Noul 或 Choice，覆盖清晰度、信息量、读者反应等维度。可选媒体路径先调用 OpenAI 视觉模型，把图像或视频首帧转换成文字描述，再把描述交给 Jev；不是 Jev 直接理解媒体。[项目说明](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/README.md)、[Jev 与独立媒体描述调用](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/background.js)、[分项标准](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/rubrics.js)。

**对 Kinshoko 的修正推论。** 可借鉴输入过程中随内容变化的轻提示，但“给资料库打整理质量分”没有充分的即时性理由。即使采用分项标准，也只是局部判断，不能把它升级为质量审查。视觉描述若需临时生成，还要把描述生成耗时算进响应时间；不能只计 Jev 调用。项目的帖子标准不能直接沿用，模型也不能从得分生成解释或裁定图像内容。

**公测后的比较修正。** 上述提交确实先描述媒体再调用 Jev，这项源码事实保留；它不能代表现在直接视觉判断的最佳流程。对“两个局部哪个更能看清刘海”这种即时问题，应将 OpenAI Decisions 直接图像输入与临时描述链路、已缓存描述链路分别计时；是否更快、更有用尚待实验。[更新后的比较方案](multimodal-decisions-evaluation.md)

## 6. skillbox：根据当前任务推荐已有工具

**已核查的调用与流程。** 自托管技能目录支持 TypeSafe、OpenRouter 和 Vercel 三种 Jev 接入。在实际推荐器中，任务与授权范围内的技能目录进入 state，每个技能对应一道 0–4 档的 Score 问题；达到配置的最低档位才返回推荐。代码限制目录规模和调用时间，缓存任务与目录版本相关的结果，调用结束后重新检查目录是否变化。没有达到门槛的技能会明确返回无匹配；调用故障则回退到文本搜索，相关性留空，而不是假称模型匹配成功。[项目说明](https://github.com/kitze/skillbox/blob/cda64ad3310abe690c6d497352791da4cfeb9a0a/README.md)、[三种真实调用、评分、缓存与回退](https://github.com/kitze/skillbox/blob/cda64ad3310abe690c6d497352791da4cfeb9a0a/src/server/recommendations.ts)。

**对 Kinshoko 的修正推论。** 若用户正在找参考，且本来就会提供用途短语，可在少量已知参考组中快速挑选当次建议；建议错了不影响手动打开其他组。这个入口的价值在于提示能在用户下一步动作前出现，而非替用户制定一套参考计划。无需全目录串行评价，也不能自动打开、加入或保存组。已有组的裁切、布局恢复由应用完成；没有文本依据时不推断未知图像内容。

## 7. wakegate：决定事件是否值得打断当前工作

**已核查的调用与流程。** 库通过 `experimental_evaluate` 调用 `typesafe-ai/jev`，输入代理等待的目标与新事件／观察，Choice 候选为 wake、not_yet、unrelated。应用读取 wake 概率决定是否唤醒。用户消息、没有可供评估的事件、连续跳过次数达到上限会直接唤醒；模型超时或失败也唤醒。README 中的 21/21 是作者小规模手工案例结果，不能当作普适准确率或节省成本的实测。[项目说明及案例说明](https://github.com/shitianfang/wakegate/blob/3a50a9e979943a3e77850f0364d8d80404124a7c/README.md)、[完整模型调用与绕过条件](https://github.com/shitianfang/wakegate/blob/3a50a9e979943a3e77850f0364d8d80404124a7c/src/index.ts)。

**对 Kinshoko 的修正推论。** 这比批量审核更接近目标模式：在事件到来时，迅速判断它是否与当前目的有关、是否值得启动较重的语义处理。模型只回答一个门控问题，不承担后续推理。是否进入昂贵处理的误判成本要分别估计；用户明确请求的处理不应被错误门控静默吞掉。固定完成／失败事件仍用规则，同步冲突、原图损坏、备份失败仍明确展示。Kinshoko 尚无需要这样门控的复杂事件流，不能为了引入 Jev 新增后台代理。

## 在 Kinshoko 中的优先顺序

筛选的依据应是“必须及时、具有语义歧义、决策范围小、误判容易纠正”，而非所有能够写成 Choice／Score／Noul 的功能。结合[领域词汇](../../GLOSSARY.md)、[已确认方向](../discovery/roadmap.md)和[数据与存储模型](../discovery/data-storage-model.md)，修正如下；截至本次更新，首版本地实现已有[规格 #42](https://github.com/Yukk1No/kinshoko/issues/42)，本表只列后续研究用途。

| 适配判断 | 局部问题 | 为什么有时效价值 | 误判与超时的处理 |
| --- | --- | --- | --- |
| 最接近原则；入口出现后验证 | 自然语言交互中的完整性、意图或少量目标判断 | 交互正在继续，复杂理解可能来不及，纯规则难以处理语义歧义 | 等待、取消或可撤销预览；过期答案丢弃；明确指令优先 |
| 有条件适合 | 在一小批候选中调整临时排序、补全或参考组提示 | 用户正在找图，需要先看见有用候选 | 原结果仍可用；不隐藏低分候选、不改长期元数据；避免结果不断跳动 |
| 有条件适合；需视觉证据 | 在已有候选局部中选更适合当前观察目的的一项 | 用户正在看图或选择局部，临时生成描述的串行步骤可能赶不上 | 优先比较直接多模态小判断；结果只影响当次提示，拒绝、未知和超时都保留原交互 |
| 模式适合，当前需求未确定 | 语义事件是否值得启动较重处理 | 单次小判断决定是否立即增加计算或打断 | 关键事件与明确请求由规则处理；区分误触发与漏触发的成本 |
| 暂不优先 | 批量分类、导入审核、整理质量评价 | 没有说明为何必须在即时交互预算内完成 | 不据此优先选择 Jev，更不能让它裁定标签真值或长期整理结果 |

首版已确认的文字／点击标签检索主要适合明确规则。未来出现实时语义交互需求时再评估 Jev，不以接入某个模型为理由扩大首版范围。

## 对当前建模的具体启发

1. **小判断有明确的有效期。** 请求关联当次输入、选中成员与状态版本，用户继续输入或改变选择后，旧判断失效。必须计入上下文准备、网络、调用与应用结果的完整耗时，超时就继续基础交互，不排队等待过期结果。
2. **人工决定仍优先。** 导入的外来标签、模型推断和人工标签不能互相覆盖；已经拒绝的建议应在重算后仍保留拒绝决定。文字名称映射与根据原图内容提出的自动标签建议应区分证据来源。全图同时有“蓝发”和“粉发”也可能因为存在不同人物，不能只凭标签共现认定矛盾。
3. **身份与执行由应用保证。** 完全相同原图的认定、引用迁移、同步冲突、坐标变换等依赖明确规则；Jev 可以提供外围建议。参考组命令应指向成员，而不是把每个成员等同于其来源参考图。
4. **不要靠层层复核制造可靠性。** 模型置信度不保证正确。如果一个小判断频繁追加大模型判断或人工复核，等待与纠错可能吃掉其全部收益。优先选错了仍可自然继续的场景，只有确有复杂理解需求时再使用较重模型。
5. **短期交互结果与长期数据分开。** 当次提示、排序与预览通常不需要同步成资料库事实；调试记录是否保留另行决定。云端判断关闭或不可用时，明确标签检索、手动整理和参考组操作仍成立。

这些是建模阶段需要考虑的关系与边界，不是已获确认的表结构、接口或 ADR。本文件没有修改现有领域定义。

## 如何以小实验验证，而不是凭社区热度选型

先选一个自然出现的即时语义判断点，固定少量候选与一份必要状态；不先增加功能来制造模型需求。比较三条路径：规则基线、小模型判断、较重模型判断。样本应包含明确输入、语义含糊、连续输入、选择变化和服务超时。

小判断后端按所需证据选择：文字／状态题比较 Jev 与 Decisions；视觉题比较直接 Decisions、描述后 Jev 与视觉基线。匹配答案空间，分别读取概率含义；同一个阈值不能跨供应商直接移用。单问题拒绝、没有合适选项、证据不足、调用失败及过期结果分别记录。具体请求差异与视觉实验见[接口核查](multimodal-decisions-evaluation.md)。

| 验证问题 | 需要观察的结果 |
| --- | --- |
| 是否赶得上交互 | 端到端 P50／P95、在本次交互有效期内返回的比例、取消和丢弃过期结果的比例 |
| 是否比规则有增益 | 规则无法处理的语义案例中，提示采纳率或操作完成时间是否改善 |
| 误判是否可承受 | 按方向记录误判、恢复原操作的时间、额外点击、误触发较重处理和漏触发的成本 |
| 是否把省下的时间花回去了 | 大模型追加调用、人工纠正、结果跳动和等待造成的总时间 |

不以模型自报置信度替代人工样本，也不只看平均延迟或单题准确率。若规则已经足够、小模型经常赶不上、误判带来更多纠正，或总要追加较重模型，就不适合放在这个点。七个社区项目提供的是可借鉴的流程，不足以冻结 Jev 为本项目依赖；服务边界见 [Jev reranker 评估](jev-reranker-evaluation.md)。
