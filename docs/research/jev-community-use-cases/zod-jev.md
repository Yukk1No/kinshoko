# 1. zod-jev：把结构合法与语义合理分开

**已核查的调用。** 库先让 Zod 检查数据结构，再对调用者提供的语义规则调用 TypeSafe SDK 的 `systemOne`。发送的 state 是 `{ value, context? }`，questions 中每条规则都是 Noul，含自然语言 instructions 和 criteria。Jev 返回 yes 概率，通过的规则不添加问题记录，其余映射为 `rejected`、`uncertain`；没有有效答案或可重试的服务故障映射为 `unavailable`。默认阈值为 0.95：大于等于 0.95 通过，小于等于 0.05 拒绝，中间保留为不确定。这个阈值是库的决策配置，不是其正确率保证。[README](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/README.md)、[真实 SDK 调用与判定](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/src/judge.ts)、[Zod 接入](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/src/semantic.ts)。

**结果如何改变流程。** 项目自己的日文出品 demo 将标题、说明、分类、状态、价格作为 value，将指南和价格参考作为 context，审核分类与文本是否一致、说明是否充分等六项条件。字段格式先由代码检查；格式不合法时不调用模型。demo 支持 off、shadow、enforce：shadow 记录判断但继续原流程；enforce 对明确否定拒绝提交，对 `uncertain` 或 `unavailable` 接受为待复核状态。裸库的语义 parse 会把不确定、不可用也当作校验问题，待复核行为来自 demo 应用的明确分支。[出品 demo 的状态与提交逻辑](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/web/listing.ts)、[另一份分阶段接入示例](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/adoption/intake.ts)。

**对 Kinshoko 的初步推论。** 结构检查与语义检查分开的形式可参考，但批量导入审核本身没有强即时性要求，不能据此优先选用 Jev。若以后存在用户输入备注时的即时轻提示，可以研究一个局部语义问题；结果只影响当次提示，不阻止提交或改变长期元数据。确定性的字段、路径和格式检查交给代码，图片内容真值也不能由文字审核裁定。

**能力边界。** demo 的照片上传是展示功能，state 明确排除照片，项目没有验证 Jev 的视觉理解。日文规则与示例证明作者使用了日文输入，不能证明其日文准确率，更不能外推中文绘画标签的效果。文本一致性判断也不能证明参考图确实包含所述内容；阈值及规则需要结合自己的样本检验。[demo 说明](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/web/README.md)、[state 构造](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/examples/web/listing.ts)。

---

返回：[《Jev 社区应用：Kinshoko 在重排之外的使用机会》索引](../jev-community-use-cases.md)。
