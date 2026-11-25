# 5. Vibe Check for X：按多个标准评价，视觉证据另行提供

**已核查的调用与流程。** 浏览器扩展将帖子草稿、回复上下文和选中的 rubrics 发给 TypeSafe `systemone`，使用 `jev-latest`。rubrics 可以分别产生 Score、Noul 或 Choice，覆盖清晰度、信息量、读者反应等维度。可选媒体路径先调用 OpenAI 视觉模型，把图像或视频首帧转换成文字描述，再把描述交给 Jev；不是 Jev 直接理解媒体。[项目说明](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/README.md)、[Jev 与独立媒体描述调用](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/background.js)、[分项标准](https://github.com/RafalWilinski/vibecheck/blob/d834d501e3deced12cf2a2551206e03482d6d238/rubrics.js)。

**对 Kinshoko 的修正推论。** 可借鉴输入过程中随内容变化的轻提示，但“给资料库打整理质量分”没有充分的即时性理由。即使采用分项标准，也只是局部判断，不能把它升级为质量审查。视觉描述若需临时生成，还要把描述生成耗时算进响应时间；不能只计 Jev 调用。项目的帖子标准不能直接沿用，模型也不能从得分生成解释或裁定图像内容。

**公测后的比较修正。** 上述提交确实先描述媒体再调用 Jev，这项源码事实保留；它不能代表现在直接视觉判断的最佳流程。对“两个局部哪个更能看清刘海”这种即时问题，应将 OpenAI Decisions 直接图像输入与临时描述链路、已缓存描述链路分别计时；是否更快、更有用尚待实验。[更新后的比较方案](../multimodal-decisions-evaluation.md)

---

返回：[《Jev 社区应用：Kinshoko 在重排之外的使用机会》索引](../jev-community-use-cases.md)。
