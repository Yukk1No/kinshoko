# 结构化选择与批量筛选样例

[← 返回索引](../jev-community-use-cases.md)

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
