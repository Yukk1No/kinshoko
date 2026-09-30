# Windows 二次元参考图库：开源项目深入调查

调查日期：2026-09-30。目标：替代 Eagle，重视小图清晰度、二次元元数据、免费开源、内容检索；接受自动识别词表有限。

本次核对了官方文档、GitHub 发布信息和源码；下载了七个候选项目的源码快照，并额外检查了主要候选的发布标签。没有安装或运行候选应用，没有用真实图库测试画质、检索准确率或速度。下文“源码发现”是静态分析，“建议”是基于这些证据的判断。

**调查结论**

确实存在围绕二次元图片组织的软件。最有用的方向是个人 Booru：角色、作品、画师和画面属性分开管理，支持标签别名、关联、来源追溯与自动识别。不过，适合收藏图片与适合绘画工作参考仍有距离。

建议保留三个重点：**Monbooru 用于近期试用，Hydrus 用于成熟管理能力对照，Project Curator 用于验证更完整的搜索方案**。没有证据支持其中任何一个已经同时解决你们的四个痛点。

| 项目 | Windows 使用方式 | 二次元与搜索能力 | 最关键的限制 | 建议 |
|---|---|---|---|---|
| [Monbooru](https://github.com/monbooru/monbooru) | 有安装包、便携包；本地程序打开浏览器界面 | 多种二次元自动标签模型；分类、别名、蕴含；标签组合与相似标签排序 | 发布版缩略图长边固定 300px；没有核实到图文向量搜索 | 第一试用候选 |
| [Hydrus Network](https://github.com/hydrusnetwork/hydrus) | 成熟的 Windows 桌面客户端 | 强标签体系、命名空间、同义关系、父子关系、下载与去重生态 | 学习成本高；采用自己的文件库；核心检索以标签为主 | 管理基准候选 |
| [Project Curator](https://github.com/FuouM/Project-Curator) | Windows 为主要目标；需自行构建 | 二次元标签、CLIP 图文搜索、以图搜图、角色识别、OCR | 没有发布包；项目很新；组合过滤存在待验证问题 | 最值得技术验证 |
| [Blombooru](https://github.com/mrblomblo/blombooru) | 自托管网页，通常 Docker + PostgreSQL | WD 自动标签，分类、别名、蕴含，Booru 导入 | 部署成本；发布版缩略图同样 300px；主要为精确标签检索 | 已有服务器时考虑 |
| [LocalBooru](https://github.com/DonutsDelivery/LocalBooru) | v2.0.5 有 Windows 安装包和 ZIP | 文件夹监听、Booru 自动标签、组合筛选 | 文档与版本不一致，近期图片加载修复；未核实到语义排序 | 观察候选 |
| [anime-illust-image-searcher](https://github.com/ryogrid/anime-illust-image-searcher) | 有较旧 Windows ZIP；网页界面 | WD 标签 + BM25 + Doc2Vec，可加权；主分支另有角色特征检索 | 发布版与主分支差异大，维护较久未更新，管理能力弱 | 搜索实验工具 |

**1. 词表限制应该拆成两件事**

自动模型只能识别预先定义的标签，和图库是否允许手动添加新标签，是两个不同的限制。Monbooru、Hydrus 等允许自建标签，因此可以在自动词表上添加职业工作用的“逆光边缘”“衣褶转折”“立绘剪影”等类别。这些只是建议的自建词，并不表示模型已经能识别它们。

固定词表适合高频的角色、服装、动作与画面属性；画师的新角色、原创角色以及专业绘画语言则需要人工补充。模型训练截止时间也影响识别：WD EVA02 v3 的模型卡说明标签数据截至 2024-02-28，并过滤掉少于 600 张训练图的标签。较新的软件未必搭载较新的识别知识。[WD 模型卡](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3)

Camie v2 的作者给出 70,527 个标签，涵盖画师、角色、作品、一般属性等类别。它扩大了覆盖范围，但作者测试集的指标不能直接换算为她的参考图库准确率，也不能作为画师署名真实性的证明。[Camie v2 模型卡](https://huggingface.co/Camais03/camie-tagger-v2)

搜索也应分别检查：

| 搜索方式 | 能解决的问题 | 不能默认期待的能力 |
|---|---|---|
| 精确标签组合 | “白发、侧脸、排除多人”，条件明确 | 没有被标注的姿势、光照找不到 |
| 标签相似度 | 从一张图找标签接近的参考 | 相同标签可能是不同构图 |
| 学习标签共现 | 某些标签不同但在图库里经常一起出现，仍能排序 | 共现关系可能学到角色关联，而非绘画构图 |
| 图文向量检索 | 用描述或示例图找内容、氛围相近的图 | 中文、精确动作、左右方向和细节准确率需要实测 |

**2. Monbooru：最适合先试，但缩略图是硬伤候选**

截至调查日，最新稳定版为 [v1.22.0，2026-09-28](https://github.com/monbooru/monbooru/releases/tag/v1.22.0)，AGPL-3.0。Windows bundled 安装包约 29MB，包含 FFmpeg 和 ONNX Runtime；识别模型仍需另行下载。它是本地程序加浏览器界面，数据保存在 SQLite，原图片保持普通文件与目录。[安装说明](https://monbooru.github.io/mondocs/getting-started/install.html)

它的元数据设计非常贴合二次元资料收集：标签分角色、画师、作品等类别；同一标签可保留多个来源，区分 AI 置信度、人工添加和网站提供；支持别名与蕴含关系。来源网站移除标签后，可以保留旧标签并标记等待处理。[标签说明](https://monbooru.github.io/mondocs/guides/tags.html)

每张图能记录多个来源链接、作者原始发布链接、网站记录的作者说明、个人笔记，以及在图片局部画框写批注。对研究用色、衣褶、结构，这比仅有一段备注更有用；这一工作适用性是我的判断。[来源与批注说明](https://monbooru.github.io/mondocs/guides/provenance.html)

自动标签目录提供 WD SwinV2 v3、animetimm EVA02、JoyTag、Camie v2；可配置分类阈值、分类输出数量及标签映射。目录标注的模型大小约为 330MB、1.3GB、430MB、789MB，属于下载体积提示，不是运行内存需求。animetimm 模型需要 Hugging Face 账号授权。[模型目录源码](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/tagger/catalog_default.json)、[自动标签文档](https://monbooru.github.io/mondocs/guides/auto-tagger.html)

搜索支持 AND、OR、排除、通配符、分类标签及尺寸等筛选。`similar:1042` 是从指定图片寻找标签接近的图，并按相似度排序。[搜索说明](https://monbooru.github.io/mondocs/guides/searching.html)

源码进一步确认：普通 `similar:` 检索采用标签集合重叠比例，公式为 `2 × 共有标签数 / 两图标签数之和`，并排除 meta 及过于普遍的标签。另一个用于关系发现的评分才是包含稀有度、画师权重的加权相似度。两者都不等同于直接理解图片构图的 CLIP 检索。[评分源码](https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/tags/similarity.go)、[搜索调用](https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/search/similarityfilter.go)

最需要先验证的是小图清晰度：**v1.22.0 的缩略图长边固定 300px，JPEG 质量 85**，图库模板使用单一缩略图地址。在高分屏或竖图较宽展示时，图片像素可能不足；但这不等于已经实测出马赛克，更不能据此诊断 Eagle 的具体原因。[缩略图源码](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/gallery/thumbnail.go)、[图库模板](https://github.com/monbooru/monbooru/blob/v1.22.0/web/templates/partials/thumbnail_grid.html)

迁出能力优于封闭数据库：原生导出结构包括标签、来源、批注、关系、收藏及搜索等字段。它仍主要使用应用数据库，不应当成“每个 JPG 都自动写入完整 XMP”。导入 Hydrus、Blombooru 的兼容层只保证图片与标签，并非全量元数据；官方迁移列表没有 Eagle。[导出结构](https://github.com/monbooru/monbooru/blob/v1.22.0/internal/galleryio/io.go)、[迁移文档](https://monbooru.github.io/mondocs/guides/migrating.html)

我的判断：它最有希望改善标签和元数据体验，且 Windows 开始试用的门槛较低；清晰度问题必须排在第一项验收。

**3. Project Curator：功能契合度最高，需要工程验证**

这是本轮补充发现。项目 2026-07-17 创建，查到最新提交为 2026-08-19；MIT 许可，没有 GitHub 发布包。Windows 10+ 是作者主要测试的平台，支持 DirectML 或 CPU，需要 Rust、Node 等环境构建。[项目说明与构建方法](https://github.com/FuouM/Project-Curator)、[发布页](https://github.com/FuouM/Project-Curator/releases)、[许可证](https://github.com/FuouM/Project-Curator/blob/main/LICENSE)

源码里能找到实际搜索路径，而非只有规划：文本经 ONNX 模型生成向量，再查询向量索引；可用标签进一步筛选。模型目录包含 CLIP ViT-B/32、MobileCLIP S2 和 Camie v2。代码还提供角色身份、OCR 等筛选入口。[搜索实现](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/search.rs)、[模型目录](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/model_manifest.json)

对缩略图问题，它提供一个具体应对方式：图库有 **Full Images** 开关；停止滚动后，逐张把可见的非视频缩略图换成原图，离开屏幕后可以退回轻量缩略图。这个实现比单纯提高缩略图尺寸更值得测试，但代价是原图解码、内存与磁盘读取。默认缩略图流程仍要检验，不能仅凭开关宣称所有小图都清晰。[加载源码](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-dashboard/src/cards.ts)、[开关界面](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-dashboard/src/views/gallery.ts)

数据层保存标签来源、置信度、时间、事务和删除状态，也有别名与标签层级表。不过“有数据表”不代表对应编辑、纠错与备份流程都完善。尚未核实到能完整往返迁移的现成图库导出流程。[数据库结构](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-db/migrations/0001_initial_schema.sql)

两个值得优先验证的源码风险：

- 文本搜索先取有限数量的向量候选，再做标签过滤；严苛条件可能留下很少结果，即使候选范围外仍有符合条件的图。
- 角色过滤先生成候选集合，但随后文本搜索会重新赋值该集合；“指定角色 + 描述”可能没有按预期取交集。这里描述的是代码路径风险，尚未运行复现。

这两点来自上面的搜索实现。中文语义搜索也没有找到足够的效果证据，不能假设使用 CLIP 就能良好理解中文绘画术语。

我的判断：如果愿意投入构建与修复成本，它最值得作为“二次元标签 + 内容搜索”的技术候选；目前不适合直接交给她替换日常工作软件。

**4. Hydrus：最成熟的对照组**

Hydrus 是长期维护的桌面标签图库，作者代码使用 WTFPL v3 许可；本次网页查到稳定版 [v688](https://github.com/hydrusnetwork/hydrus/releases/tag/v688)。它支持命名空间，例如 `character:`、`series:`，以及同义标签、父标签、多标签组合和排除。这是把二次元收藏管理做深的成熟路线。[标签文档](https://hydrusnetwork.github.io/hydrus/getting_started_tags.html)、[许可证](https://github.com/hydrusnetwork/hydrus/blob/master/LICENSE)

它的数据不依赖单个平面标签列表，适合解决角色译名、罗马字、作品简称等一致性问题。代价是界面与概念较多，整理规则需要学习。源码存在缩略图设备像素比例配置 `thumbnail_dpr_percent`，比固定 300px 的设计更值得放入高分屏对照测试；这里没有实测其效果。[配置源码](https://github.com/hydrusnetwork/hydrus/blob/master/hydrus/client/ClientOptions.py)

文件导入后进入自己的管理库，通常按哈希命名；并非仅给原有文件夹加一个检索索引。支持以旁车 TXT/JSON 等形式交换标签、URL、笔记等数据，但需要配置映射。核心检索以标签为主；本次没有核实到原生图文语义搜索。[导入导出](https://hydrusnetwork.github.io/hydrus/getting_started_importing.html)、[旁车文件](https://hydrusnetwork.github.io/hydrus/advanced_sidecars.html)

我的判断：如果她愿意学习标签体系，Hydrus 是值得与 Monbooru 同时比较的成熟候选；若要保持原目录结构，必须先接受它的文件管理方式。

**5. Blombooru：完整个人 Booru，但不解决全部痛点**

MIT 许可，本次 API 查到稳定版 [v1.40.1，2026-06-22](https://github.com/mrblomblo/blombooru/releases/tag/v1.40.1)。主分支在 9 月仍有更新，不能直接把主分支全部功能计入这个稳定版。

已核实的发布版数据模型包含分类标签、别名、蕴含关系、来源、描述、父子图和相册体系；适合从 Booru 导入现成标签。部署为自托管网页，一般需要 Docker 与 PostgreSQL。对 Windows 单人工作环境，维护成本比 Monbooru 高。[项目说明](https://github.com/mrblomblo/blombooru)、[发布版数据模型](https://github.com/mrblomblo/blombooru/blob/v1.40.1/backend/app/models.py)

**发布版缩略图同样固定在 300×300 边界内，JPEG 质量 85**；一般图片使用 Lanczos 缩放。这说明“二次元专用”也未必更重视高分屏线稿展示。其检索主要是标签与字段条件，本次未核实到直接图文向量搜索。[缩略图实现](https://github.com/mrblomblo/blombooru/blob/v1.40.1/backend/app/utils/thumbnail_generator.py)、[搜索解析](https://github.com/mrblomblo/blombooru/blob/main/backend/app/utils/search_parser.py)

我的判断：若已有 NAS 或服务器并愿意维护数据库，可以考虑；作为她 Windows 上的直接 Eagle 替代，优先级低于 Monbooru。

**6. anime-illust-image-searcher：搜索思路值得保留，软件成熟度要下调**

MIT 许可；最新稳定版 [v1.1.1 发布于 2024-10-30](https://github.com/ryogrid/anime-illust-image-searcher/releases/tag/v1.1.1)，Windows ZIP 约 409MB；主分支最后提交为 2025-03-02。

它根据 WD 自动标签构建 BM25 索引，并在用户图库的标签文本上训练 Doc2Vec。支持加权词和必选、排除条件；它的“语义”主要来自标签共现，而不是直接学习图像的构图。数据库词表由实际进入索引的图片标签生成，少于三个标签的图片会被跳过。[主分支索引实现](https://github.com/ryogrid/anime-illust-image-searcher/blob/32dc1a7ad3d4b8e57655c35abbff55777dd12976/genmodel.py)

发现以下重要版本与代码问题：

- v1.1.1 发布源码没有主分支后来加入的 `--update` 和角色特征重排，不能把这些计入现成 ZIP 的能力。
- 主分支增量更新复用旧词典和旧 Doc2Vec 模型，未扩充词表；后来加入的新标签可能被索引忽略，需要全量重建。
- 查询直接访问 `dictionary.token2id[tag]`，没有词表外标签的安全降级；输入未收录词可能报错。
- Windows 导出结果路径使用 Shift-JIS 编码；无法编码的中文路径会被捕获异常后跳过，存在结果导出遗漏风险。
- v1.1.1 必选词评分分支使用 `scores += score - REQUIRE_TAG_MAGIC_NUMBER`，与“保留用户权重”的意图不一致；主分支已改动该算式。实际影响仍需运行验证。

证据：[发布版查询与导出源码](https://github.com/ryogrid/anime-illust-image-searcher/blob/v1.1.1/webui.py)、[发布版建模源码](https://github.com/ryogrid/anime-illust-image-searcher/blob/v1.1.1/genmodel.py)、[主分支查询源码](https://github.com/ryogrid/anime-illust-image-searcher/blob/32dc1a7ad3d4b8e57655c35abbff55777dd12976/webui.py)。这些是静态发现，没有现场运行复现。

它的界面主要浏览搜索结果、显示标签和导出文件路径；没有核实到完善的作者来源、批注与标签编辑工作流。我的判断：可以用于验证“标签共现搜索是否有价值”，不推荐作为她的工作主图库。

**7. 其余候选为何没有排在前面**

[LocalBooru](https://github.com/DonutsDelivery/LocalBooru)：MIT，v2.0.5 在 2026-09-27 发布，确实有 Windows 安装包和 ZIP。README 下载表仍指向旧 0.3.33，不能据此认定 Windows 停留在旧版本。v2.0.5 发布说明明确修复图片路由与错误提示，同时保留了尚未复现的 Windows 故障说明。主分支现已改称 DonutMediaCenter，方向扩展到视频和音乐。当前证据主要支持自动标签与组合筛选，没有核实到更强语义检索。[准确的发布说明](https://github.com/DonutsDelivery/LocalBooru/releases/tag/v2.0.5)、[v2.0.5 README](https://github.com/DonutsDelivery/LocalBooru/blob/v2.0.5/README.md)

[ImoutoRebirth](https://github.com/ImoutoChan/ImoutoRebirth)：明确以 anime images 为重点，有原生 Windows Navigator/Viewer、网站哈希查标签、批量编辑、Pixiv ugoira 与网站批注。安装需要多项后台服务及数据库。仓库虽然作者称已开源，但此次没有找到项目根许可证或明确项目级授权，GitHub API 的 license 也为空；因此暂不把它列入“已核实有开源许可证”的推荐名单。[项目与安装说明](https://github.com/ImoutoChan/ImoutoRebirth)

[V.I.O.L.E.T.](https://github.com/kyloris0660/VIOLET)：MIT，来自 Blombooru，明确围绕本地二次元/插画、中文、标签来源和人工纠错设计。没有发布包；当前 README 的验证状态仍限制在合成或临时数据，GIF/AVIF 明确不支持。它有研究价值，但不能把详细设计与验证文档当成已经稳定交付的用户产品。[当前状态](https://github.com/kyloris0660/VIOLET/blob/main/README.md)

**8. 如何做有意义的小规模验收**

第一轮用原图库的副本，选 300～500 张即可。样本包括黑白线稿、细线彩图、厚涂、竖向立绘、多人图、冷门/原创角色，以及带中文路径的图片。以下是建议的测试方案，尚未执行。

| 项目 | 验收方法 | 记录什么 |
|---|---|---|
| 缩略图清晰度 | 在她实际屏幕、Windows 缩放比例和常用网格大小下对比 Eagle、Monbooru、Hydrus；Curator 比较 Full Images 开关 | 细线、眼睛、衣褶是否清楚，停止滚动后的变化 |
| 查参考图 | 由她先写 20 个实际工作查询，手动挑出目标图；再用软件搜索 | 前 20 张中有用参考的数量、目标遗漏、找图耗时 |
| 标签质量 | 抽查 100 张，对角色/作品、服装/动作分别统计 | 错标、漏标，人工修正成本 |
| 元数据 | 添加画师、多个来源、笔记、局部批注、中文别名；再重启、导出、导入 | 字段是否保留，来源是否可区分 |
| 增量整理 | 添加、重命名、移动一批副本，再改几个标签 | 是否产生失联、重复、错误覆盖 |
| 性能 | 同一批图片、相同机器先完成索引，再重复实际查询 | 首次索引耗时与之后检索耗时分开记录 |

自动标签只承担可识别的画面属性；另设少量她确实会检索的专业标签。优先测试“自动识别＋少量人工补充”能否减少实际工作，而不是追求标签数量最多。

Eagle 迁移方面，本轮没有核实到上述重点开源候选支持完整无损原生导入 Eagle 库。应把图片、标签、作者来源、备注、文件夹与收藏分别列出，再验证映射。选软件前先验证一小批元数据能往返，比直接搬完整图库更有价值。后文补充的 Nephele 提供官方宣称的 Eagle 文件格式兼容，实际完整性尚未测试。

**补充关注名单（interest）：Nephele Workshop**

加入日期：2026-09-30。由用户提供：[中文官网](https://nephele.creatoraris.com/zh)。状态：**高关注，待实测；画师工作流商业产品参照**。本项仅核对官方说明，没有安装，没有审计其公开组件源码。

官网当前列出 Windows 10/11 64 位版本 v0.8.2-beta.1，日期为 2026-09-23。产品面向画师，包含素材整理、参考板、网页剪藏等功能，定位与本次需求较贴近。[官网](https://nephele.creatoraris.com/zh)

值得关注的能力：

- 可创建自己的 Nimbus 库，也可接入已有 Eagle 库；官方说明直接处理库文件，无需 Eagle 运行。能查看标签、来源、属性并筛选，来源与作者归属修正仍标为实验功能。[资源库文档](https://nephele.arisfusion.com/zh/docs/library)、[Eagle 兼容说明](https://nephele.arisfusion.com/zh/docs/eagle)
- 本地索引使用 PixAI Tagger v0.9，WD SwinV2 作为回落模型；官方描述同时提供图像特征相似检索、CLIP 以文搜图，以及 gte-multilingual-base 的跨语言标签语义检索。这三条路径需要分别测试，不能把中文标签语义检索当作完全相同的图文向量检索。文档还说明中文 CLIP 查询由 Agent 翻译后检索，整条中文流程是否需要云端应实测确认。[索引文档](https://nephele.arisfusion.com/zh/docs/indexing)

开源与费用边界：**桌面应用整体为闭源商业软件**；公开的 MIT 仓库为安全审计子集、移动端伴侣、浏览器扩展和独立验证器，不能因此归为完整开源图库。当前 Beta 标价 ¥198，本地功能买断，附带一年云端 AI；云端续费与本地授权分开，支持先试用。[开源范围](https://nephele.arisfusion.com/zh/docs/open-source)、[定价说明](https://nephele.creatoraris.com/zh/docs/pricing)

下一次评估重点：小图实际清晰度；颜色、姿势、角色检索对绘画参考的效果；人工标签和来源是否完整保留；Eagle 库读写兼容性；中文检索的本地/云端边界。暂未找到足以确认缩略图实现或高分屏效果的证据，因此不预先判断它解决了清晰度问题。

**最终选择建议**

近期先试 Monbooru bundled Windows 版，同时把 Hydrus 作为标签与缩略图对照；Monbooru 如果在她的常用小图布局下仍不清晰，就不能算成功替代。若还愿意做技术验证，Project Curator 优先于较旧的 anime-illust-image-searcher：它已经具备更贴近需求的搜索与原图加载代码，但需要构建、检查搜索组合逻辑和真实工作样本测试。

本轮没有形成“开源二次元 Eagle 完整替代品已经成熟”的结论；形成的是可追溯的候选排序、明确的实现差异，以及能快速淘汰不合适候选的验证方法。
