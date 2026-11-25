# 6. skillbox：根据当前任务推荐已有工具

**已核查的调用与流程。** 自托管技能目录支持 TypeSafe、OpenRouter 和 Vercel 三种 Jev 接入。在实际推荐器中，任务与授权范围内的技能目录进入 state，每个技能对应一道 0–4 档的 Score 问题；达到配置的最低档位才返回推荐。代码限制目录规模和调用时间，缓存任务与目录版本相关的结果，调用结束后重新检查目录是否变化。没有达到门槛的技能会明确返回无匹配；调用故障则回退到文本搜索，相关性留空，而不是假称模型匹配成功。[项目说明](https://github.com/kitze/skillbox/blob/cda64ad3310abe690c6d497352791da4cfeb9a0a/README.md)、[三种真实调用、评分、缓存与回退](https://github.com/kitze/skillbox/blob/cda64ad3310abe690c6d497352791da4cfeb9a0a/src/server/recommendations.ts)。

**对 Kinshoko 的修正推论。** 若用户正在找参考，且本来就会提供用途短语，可在少量已知参考组中快速挑选当次建议；建议错了不影响手动打开其他组。这个入口的价值在于提示能在用户下一步动作前出现，而非替用户制定一套参考计划。无需全目录串行评价，也不能自动打开、加入或保存组。已有组的裁切、布局恢复由应用完成；没有文本依据时不推断未知图像内容。

---

返回：[《Jev 社区应用：Kinshoko 在重排之外的使用机会》索引](../jev-community-use-cases.md)。
