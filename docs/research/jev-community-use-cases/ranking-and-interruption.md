# 评价、推荐与打断样例

[← 返回索引](../jev-community-use-cases.md)

## 5. Vibe Check for X：按多个标准评价，视觉证据另行提供

**已核查的调用与流程。** 浏览器扩展将帖子草稿、回复上下文和选中的 rubrics 发给 TypeSafe `systemone`，使用 `jev-latest`。rubrics 可以分别产生 Score、Noul 或 Choice，覆盖清晰度、信息量、读者反应等维度。可选媒体路径先调用 OpenAI 视觉模型，把图像或视频首帧转换成文字描述，再把描述交给 Jev；不是 Jev 直接理解媒体。[项目说明](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/README.md)、[Jev 与独立媒体描述调用](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/background.js)、[分项标准](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/rubrics.js)。

**对 Kinshoko 的修正推论。** 可借鉴输入过程中随内容变化的轻提示，但“给资料库打整理质量分”没有充分的即时性理由。即使采用分项标准，也只是局部判断，不能把它升级为质量审查。视觉描述若需临时生成，还要把描述生成耗时算进响应时间；不能只计 Jev 调用。项目的帖子标准不能直接沿用，模型也不能从得分生成解释或裁定图像内容。

**公测后的比较修正。** 上述提交确实先描述媒体再调用 Jev，这项源码事实保留；它不能代表现在直接视觉判断的最佳流程。对“两个局部哪个更能看清刘海”这种即时问题，应将 OpenAI Decisions 直接图像输入与临时描述链路、已缓存描述链路分别计时；是否更快、更有用尚待实验。[更新后的比较方案](../multimodal-decisions-evaluation.md)

## 6. skillbox：根据当前任务推荐已有工具

**已核查的调用与流程。** 自托管技能目录支持 TypeSafe、OpenRouter 和 Vercel 三种 Jev 接入。在实际推荐器中，任务与授权范围内的技能目录进入 state，每个技能对应一道 0–4 档的 Score 问题；达到配置的最低档位才返回推荐。代码限制目录规模和调用时间，缓存任务与目录版本相关的结果，调用结束后重新检查目录是否变化。没有达到门槛的技能会明确返回无匹配；调用故障则回退到文本搜索，相关性留空，而不是假称模型匹配成功。[项目说明](https://github.com/kitze/skillbox/blob/cda64ad3310abe690c6d497352791da4cfeb9a0a/README.md)、[三种真实调用、评分、缓存与回退](https://github.com/kitze/skillbox/blob/cda64ad3310abe690c6d497352791da4cfeb9a0a/src/server/recommendations.ts)。

**对 Kinshoko 的修正推论。** 若用户正在找参考，且本来就会提供用途短语，可在少量已知参考组中快速挑选当次建议；建议错了不影响手动打开其他组。这个入口的价值在于提示能在用户下一步动作前出现，而非替用户制定一套参考计划。无需全目录串行评价，也不能自动打开、加入或保存组。已有组的裁切、布局恢复由应用完成；没有文本依据时不推断未知图像内容。

## 7. wakegate：决定事件是否值得打断当前工作

**已核查的调用与流程。** 库通过 `experimental_evaluate` 调用 `typesafe-ai/jev`，输入代理等待的目标与新事件／观察，Choice 候选为 wake、not_yet、unrelated。应用读取 wake 概率决定是否唤醒。用户消息、没有可供评估的事件、连续跳过次数达到上限会直接唤醒；模型超时或失败也唤醒。README 中的 21/21 是作者小规模手工案例结果，不能当作普适准确率或节省成本的实测。[项目说明及案例说明](https://github.com/shitianfang/wakegate/blob/3a50a9e979943a3e77850f0364d8d80404124a7c/README.md)、[完整模型调用与绕过条件](https://github.com/shitianfang/wakegate/blob/3a50a9e979943a3e77850f0364d8d80404124a7c/src/index.ts)。

**对 Kinshoko 的修正推论。** 这比批量审核更接近目标模式：在事件到来时，迅速判断它是否与当前目的有关、是否值得启动较重的语义处理。模型只回答一个门控问题，不承担后续推理。是否进入昂贵处理的误判成本要分别估计；用户明确请求的处理不应被错误门控静默吞掉。固定完成／失败事件仍用规则，同步冲突、原图损坏、备份失败仍明确展示。Kinshoko 尚无需要这样门控的复杂事件流，不能为了引入 Jev 新增后台代理。
