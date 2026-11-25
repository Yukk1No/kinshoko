# 3. jev-curate：把多个小判断组合成批量筛选

**已核查的调用。** Rust 客户端向 `https://api.typesafe.ai/v1/systemone` 发送 HTTP 请求，源码固定 `model: 'jev-1.13.0'`。每条记录先做文本清理与空白、过短等检查，再以 `{ text: clean_text }` 为 state，一次请求发送一组问题。当前三个预设使用 Noul 检查循环论证、奉承、免责声明、代码占位等现象，用 Score 按五档 criteria 判断推理深度或代码质量。虽然类型可表达 Choice，现成预设及筛选流程没有据 Choice 给数据分组。[API 客户端](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/client.rs)、[预设问题与阈值](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/presets.rs)、[预检查与模型调用](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/filter.rs)。

**结果如何改变流程。** Noul 超过拒绝阈值或 Score 低于最低档位时，记录被放到 rejected；其余进入 clean。调用失败、缺失答案也被放到 rejected，附原因。JSONL 路径保留原始行，拒绝文件另存理由；执行路径没有把各题概率、分数、模型使用信息一起写入输出文件。README 的 24 rows/s 来自本地 mock benchmark，不能作为真实 Jev 吞吐证据。[筛选判定](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/filter.rs)、[任务与输出调用](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/main.rs)、[输出文件实现](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/parquet_io.rs)、[README 的 benchmark 注释](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/README.md)。

**对 Kinshoko 的修正判断。** 批量整理可以用许多处理方式，速度与价格也可能有意义，但它不能说明为何要在实时交互中使用小判断模型。故不再把该项目对应的整理功能列为本次优先验证方向。可保留预检查、保全原始数据和区分调用失败的工程经验；它们本身并不要求 Jev。

**能力边界。** 预设面向数学、代码等文本训练集，不能原样解释绘画参考的价值。源码实际先把数据集读进内存，不能仅凭 README 当作已验证的流式导入器；Parquet 路径只取选中的文本列，其他列未写回，不能直接用于保留完整参考图元数据。它提供的是可借鉴的筛选结构，完整导入、原始记录保全及复核状态仍需另行设计。[数据读取与列选择](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/parquet_io.rs)、[批量执行](https://github.com/AkashPriyadarshii/jev-curate/blob/837478efb70e16a14c97946007b9864711a4230a/src/main.rs)。

---

返回：[《Jev 社区应用：Kinshoko 在重排之外的使用机会》索引](../jev-community-use-cases.md)。
