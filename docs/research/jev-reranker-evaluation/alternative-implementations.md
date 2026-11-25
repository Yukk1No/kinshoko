# 其他可比较的实现路径

除了 Jev，可以用同样的实验协议比较下列路径。这些是可获取性和接口核查，不是准确率或速度排名。

| 路径 | 一手资料支持的能力 | 对 Kinshoko 的适配判断 |
| --- | --- | --- |
| 本地标签、别名与规则排序 | 应用能够直接执行已确认条件，并利用有效标签与人工整理信息。 | 必备基线；先确认复杂模型相对它有多少实际增益。 |
| OpenAI Decisions API，`gpt-6-luna` | 2026-10-06 已发布 beta，接收文字与内联图像，返回专门的三类判断；其标准价为输入 $0.10／百万 token，输出不收费。它是云服务，不是开放权重。[指南](https://developers.openai.com/api/docs/guides/decisions)、[Decisions 定价](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability) | 对必须看图的即时小问题，优先验证直接判断候选局部；图像准备、上传、拒绝和误判均计入完整流程。详见[接口与对照评估](../multimodal-decisions-evaluation.md)。 |
| 本地文字决策模型，例：Bekko System One v0 | 同一作者于 2026-09-30 发布 17M／68M／400M 英文模型，支持 Choice／Noul／Score 和本地推理。17M 浏览器 ONNX 文件约 29 MB，但不包括运行时和工作内存；作者明确承认泛化明显弱于 Jev。[作者模型卡](https://huggingface.co/hotchpotch/bekko-system-one-v0-17m)、[发布说明](https://huggingface.co/blog/hotchpotch/bekko-system-one-v0-release) | 说明轻量、本地的结构化判断已有开放探索；英文与泛化限制使它目前适合作为研究对照，不能据演示选为中文图库默认方案。 |
| 本地多模态重排，例：Qwen3-VL-Reranker-2B | 官方提供图文配对相关性评分、可定制指令和本地加载示例；模型卡标注 Apache-2.0。官方仓库列出中文、日文支持，并说明用 yes／no token 的概率评价相关性。[模型卡](https://huggingface.co/Qwen/Qwen3-VL-Reranker-2B)、[官方架构与语言说明](https://github.com/QwenLM/Qwen3-VL-Embedding) | 更适合验证原图是否满足参考用途。2B 模型与推理资源需求需实测，不能因支持图像就承诺发型细节、人物归属和局部坐标准确。 |
| 普通模型做有限判断 | TypeSafe 官方适配器提供相似原语与可替换 endpoint，便于比较后端。[官方适配器](https://github.com/typesafe-ai/system-one-adapter-python) | 可用来测结构化判断的价值；开放模型的校准、延迟和本地资源成本需分别评估。 |

初次研究记录的 Qwen 2B 官方仓库文件总量约 4.27 GB，明显需要独立评估下载与运行资源；该数值是文件体积，不是内存或显存要求，本次没有重新核对仓库体积。未核实量化配置、Windows CPU／GPU 延迟与二次元专项成绩。[官方文件目录](https://huggingface.co/Qwen/Qwen3-VL-Reranker-2B/tree/main)

这些路径也说明：可以先复用已有的图文重排能力验证用途，再决定是否需要更小、更专门或结合人工反馈的模型。训练自有通用 System One 模型目前没有足够的领域样本和收益证据支持。

---

返回：[《Jev 与候选用途判断：Kinshoko 适用性评估》索引](../jev-reranker-evaluation.md)。
