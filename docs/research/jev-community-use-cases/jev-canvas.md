# 4. jev-canvas：自然语言选操作，应用计算布局

**已核查的调用与流程。** 项目结合 tldraw、浏览器语音转录和手部指向。服务器通过 OpenRouter 的 decisions 接口调用 `typesafe/jev-1.13`。state 包含转录文本、形状的短 ID、类别、颜色、坐标、尺寸、选中状态和视口；手部识别提供的是指向坐标，Jev 没有收到摄像头画面。Noul 判断是否为命令及是否完整，Choice 选择 create、move、delete、recolor、resize 等操作和已有目标，Score 选择尺寸档位。当前构造器限制转录到 300 字符、形状到 40 个。[项目说明](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/README.md)、[真实 API 调用](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/server/decide.js)、[state 与问题构造](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/shared/questions.js)。

模型答案经过独立 policy：检查命令、完整度、目标等概率，返回执行、等待或忽略；位置和缩放由代码算，目标缺失时也会尝试指向、唯一对象或选中对象等明确上下文。源码中的删除和清空同样可以成为执行命令，不能把其策略直接搬到本项目。[答案处理与几何计算](https://github.com/gaborishka/jev-canvas/blob/cec7b27a9f9a3cf12e6692ca07dfeb6125f3cccd/shared/policy.js)。

**对 Kinshoko 的修正推论。** 更值得借鉴的是即时交互中的小判断：在已有自然语言或语音入口时，判断一句话是否还没说完，或在少量已知操作／目标中解释“这张再近一点”。明确目标及操作仍可直接由规则处理；模型仅补足其中的语义歧义。错误只应影响可取消的提示、操作预览或可撤销的显示变化。不能因为社区示例就决定新增语音功能。操作目标使用成员 ID，返回后验证状态；结果若已过交互期限或用户已改变选择就丢弃。它也不证明模型能定位眼睛，局部区域仍需已知坐标或图像识别能力。

---

返回：[《Jev 社区应用：Kinshoko 在重排之外的使用机会》索引](../jev-community-use-cases.md)。
