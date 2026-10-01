# 图库存储实践：Monbooru、Hydrus 与两项补充

调查日期：2026-10-01。只检查官方源码与同仓库文档，没有启动候选应用、下载模型或用真实资料库验证。下文“代码行为”指静态可追到的分支；验收案例尚未执行。未读取访谈历史，也未修改领域定义与 ADR。

| 项目 | 本次固定版本与 commit |
|---|---|
| Monbooru | [v1.22.0 / f49d97e45de899e4413bc5239c4efe3e799fdf2d](https://github.com/monbooru/monbooru/commit/f49d97e45de899e4413bc5239c4efe3e799fdf2d)，2026-09-28 |
| Hydrus | [v688 / e1cbffc2f7d4a64a44cc25345718cde363ef6221](https://github.com/hydrusnetwork/hydrus/commit/e1cbffc2f7d4a64a44cc25345718cde363ef6221)，2026-09-23 |
| Blombooru | [v1.40.1 / 18dc659930fd7bc13fd1dc750b2fc0bc3f5eed6a](https://github.com/mrblomblo/blombooru/tree/18dc659930fd7bc13fd1dc750b2fc0bc3f5eed6a) |
| LocalBooru | [v2.0.5 / 79ad5ff0b634ace3f74d28651311381b03f8fc1e](https://github.com/DonutsDelivery/LocalBooru/tree/79ad5ff0b634ace3f74d28651311381b03f8fc1e) |

Monbooru、Hydrus 的 commit 元数据与 Blombooru、LocalBooru 的发布标签指向均经官方 GitHub API 核对；没有把主分支变化计入这些版本。

最影响 Kinshoko 当前选择的三件事：**完整导出不等于完整合并；哈希相同不表示整理决定相同；记录 ID 不一定指向永远不变的原文件。** 四个项目都不能直接证明“独立参考组跨资料库引用、合并后原库保留”已经有现成可靠实现。

## 原文件、元数据与身份分别放在哪里

| 项目 | 原文件与元数据分工 | 实际身份与重复判定 |
|---|---|---|
| Monbooru | 普通图片目录；每个 gallery 单独的 `monbooru.db`、缩略图目录。`images` 保存属性和个人备注，`image_paths` 保存文件路径；来源、批注、标签和关系另有表。[配置][m-config]、[schema][m-schema] | `images.id` 是库内整数；`sha256 UNIQUE` 合并同字节路径。自己计算的 `md5` 与来源声称的 `image_sources.md5` 分开，后者明确不作去重依据；`phash` 另用于发现关系。[schema][m-schema]、[导入][m-ingest] |
| Hydrus | 导入复制到管理目录，例如 `client_files/fxx/<sha256>.<ext>`，缩略图位于 `txx`；设置、标签、笔记、状态等存在多份 `client*.db`。旁车用于交换元数据，内部保存不依赖旁车。[文件路径与复制][h-files]、[备份文档][h-install]、[旁车文档][h-sidecar-doc] | `client.master.db` 的 `hashes(hash_id, hash BLOB UNIQUE)` 给 SHA-256 分配库内整数，MD5/SHA1/SHA512 在 `local_hashes`。名字和原目录不决定身份。[主表][h-master]、[导入][h-import] |
| Blombooru | 原文件在应用的 `media/original`；PostgreSQL 的 `blombooru_media` 存属性、`source`、`description`，关系表存标签与相册。[模型][b-model]、[原文件归档路径][b-restore] | `Media.id` 为主键；`path UNIQUE`、`hash UNIQUE`。虽然 `hash` 列长为 64，实际 `calculate_file_hash` 算的是 MD5，不能看列长推断算法。[模型][b-model]、[哈希实现][b-hash] |
| LocalBooru | 通常引用原目录而不复制文件。`library.db` 保存目录、全局标签/别名等；`directories/<directory_id>.db` 保存各目录的图片和路径。目录库的 `image_tags.tag_id` 指向全局标签，没有跨数据库外键约束。[模型][l-model]、[导入][l-import] | 目录库内 `DirectoryImage.id` 与 `file_hash UNIQUE`；实际普通模式算全文件 xxh64，默认快速模式算“大小＋首尾各 64KiB”的 xxh64。`file_hash` 注释里的 SHA256 不足以证明入口真的使用 SHA256。[导入和哈希][l-import] |

这些整数都要连同所属数据库理解。Monbooru 的配置以 `Gallery.Name`、路径及由名称派生的数据库目录定位库；本轮检查的配置和 schema 没有发现持久的 gallery UUID。LocalBooru 分离了图片数据库，却仍依赖主数据库的目录编号和标签编号，因此“复制一份目录数据库”不等于“得到一个可独立管理的资料库”。这两点是对跨库引用可借鉴的边界，而不是现成身份方案。[Monbooru 配置][m-config]、[LocalBooru 模型][l-model]

## Monbooru：保留来源很细，操作之间保留范围仍有差别

**同库同字节会共用一份整理记录。** `ingestWithHash` 先查 SHA-256：原文件还在时，把新路径记成 `image_paths` 的非 canonical 路径；原路径消失时提升新路径；`is_missing=1` 时重新启用旧图片记录，保留原有标签等关联。因此不同文件名不能保留两套不同备注。不同 gallery 的数据库则各自保存元数据。[`ingestWithHash`][m-ingest]、[gallery 配置][m-config]

**图片记录可保持 ID，同时更换内容哈希。** `sync.go/applyInPlaceEdit` 对原路径字节变化执行 `UPDATE images SET sha256=… WHERE id=…`，更新尺寸、生成参数和派生图；普通标签、个人备注、批注、集合成员与关系没有在这段流程中全部清除。这为“文件编辑后整理仍跟着记录走”提供一个实例，但原像素坐标批注和参考裁切可能不再适用；不能把该项目的 `image_id` 当作不可变原图的身份证明。[`applyInPlaceEdit`][m-sync]

**来源声明与最终挂在图上的标签分开保存，但还不是完整的逐来源建议记录。** `image_tags(image_id, tag_id)` 保存 `is_auto/is_implied/confidence/tagger_name/stale`；`image_tag_sources(image_id, tag_id, source)` 另存多个来源。`tags` 中别名用 `canonical_tag_id` 指向规范标签，名称与类别共同唯一。添加优先级是 implied → auto → manual，只提升不降级；网站标签也写成 `is_auto=0`，不能把这个标志直接解释为用户确认。置信度仍在单个 `image_tags` 行中，多来源表只保存来源与时间，不能重建每个模型的一套分数。可借鉴多来源账目，自动建议与人工确认仍需另行验证。[schema][m-schema]、[来源表迁移][m-bootstrap]、[标签写入][m-tags]

**来源撤回与人工删除是两件事。** `SyncSourceTags` 对上次来源已不再列出的标签标 `stale`，没有立即删除；还保护已经存在的 rating。`RemoveTagFromImage` 则删除标签行，触发器也删除来源账目，没有在这条流程中留下“用户否定该图的该标签”记录。因此相同来源或模型再次添加时，没有这份否定记录可供过滤。这里说的是已读分支，不是对所有导入入口的运行结论。[`SyncSourceTags`、删除逻辑][m-tags]、[清理触发器][m-bootstrap]

**局部批注属于图片，不属于图片的一次使用。** `image_annotations` 的 `x/y/w/h` 是原图像素，另有 `site/post_id/body/manual`。重新拉取某来源只替换该来源 `manual=0` 的框，自己画的框保留；编辑网站框并不会改变其 `manual` 标记，重拉仍会覆盖它。集合成员是 `(image_id, name, position)`，同图在同名集合只能出现一次；关系另有 duplicate/alternate 分组、version/derivative 边。这里没有 Kinshoko 参考组成员那种同图多次使用、各次独立裁切和布局的数据。[schema][m-schema]、[批注写入][m-annotations]

下表尤其不能混为一种“迁移能力”：

| 入口 | 此 commit 实际带走或应用什么 |
|---|---|
| 原生完整 JSON/DB/ZIP → replace import | JSON `ExportVersion=12` 包含标签目录/别名、标签来源、图片来源、批注、集合、文件关系、笔记、收藏等；JSON 恢复直接写表，保留文档内 ID。ZIP 再放原文件。[`Export`、`loadExportIntoDB`][m-io] |
| 原生完整 JSON/DB/ZIP → merge | `mergeRecord` 只有 `SHA256/Tags/SourcePath`。旧图按 SHA 匹配并添加标签；ZIP 才能带来新图。**不会因输入是完整导出就汇合备注、批注、来源、集合、关系与别名目录。**[`readExportMergeRecords`、`applyMergeRecords`][m-merge] |
| 单图复制/转移到另一 gallery | 添加标签与部分来源字段、批注；个人 `note/original_source` 只填目标空值，收藏取 OR。人工框按几何与正文去重。代码明确集合和关系不转移；有目标同 SHA 也不保留两份不同非空个人备注。[`TransferOneImage`、`transferProvenance`][m-transfer] |
| lightweight manifest / selection download | 更接近图片与标签交换，不是完整资料库恢复；不能继承完整导出的关系保证。[light export][m-merge] |

完整 JSON 的数据库读取放在一个只读事务里，DB 导出用 `VACUUM INTO`；两者都考虑了 SQLite 的完整快照。**ZIP 是先导元数据，再遍历磁盘文件**，根目录不可读时仍能产出没有原文件的包；未证明外部改图或文件移动期间有统一文件快照。对选图 JSON，关系过滤还需要检查依赖：例如 version 边按 child 筛选，parent 可能不在导出的图片集合中。保留一个关系字段，不等于关系所有端点均已打包。[`ExportGalleryJSON`、`ExportGalleryArchive`][m-io]

移动会先搬文件再改数据库，数据库失败时尝试搬回；删除则先提交数据库删除与级联，再删文件。文件夹 Sync 在文件失联时通常先标 missing，显式删除才删除整理记录。可借鉴的是区分失联和用户删除，以及失败后补偿；不能由 SQL 事务推断数据库和文件移动/删除一起具有断电原子性。此处 Sync 指文件目录与数据库对账，未验证多机同步。[移动][m-move]、[删除][m-delete]、[目录对账][m-sync]

## Hydrus：把删除决定与内容身份保存下来

**同一 SHA-256 会认出原文件，也会认出“以前删过它”。** `FileImportJob` 先算全文件 SHA-256，再查询状态；未知文件或获准重导的已删除文件才复制入库，已导入文件仍可执行导入后的内容更新。`deleted_files_<service_id>` 留有删除时间、原导入时间等信息，是否允许重导已删除文件由导入选项决定。标签更新来自 `FileSeed.WriteContentUpdates`，会按选项给已存在图片补充标签/笔记，而不是创建“同文件的第二份 metadata 记录”。物理文件复制在数据库写入前执行，因而仍有文件/DB 分步完成的恢复边界。[文件导入][h-import]、[FileSeed 内容更新][h-seeds]、[文件状态表][h-storage]

**人工删除标签可以阻止普通重导恢复它。** 每个 tag service 有 `current/deleted/pending/petitioned_mappings_<service_id>(tag_id, hash_id)`。`ServiceTagImportOptions` 的两个 overwrite-deleted 开关默认 false，`FilterNotPreviouslyDeletedTags` 对导入标签减去 deleted 集合。这个机制比只删标签行更适合保留用户纠错；但它按 service 保存，不能自动回答两个独立资料库合并时 A 删除、B 保留应如何处理，也不能认为所有 API 添加都使用这条过滤路径。[映射表][h-mappings]、[导入过滤][h-tag-options]

别名即 siblings，保存 `bad_tag_id/good_tag_id`，并有 storage 关系与 actual/ideal 展示缓存；`tag_sibling_application(master_service_id, service_index, application_service_id)` 保留服务应用顺序。文件标签映射本身没有逐来源模型、置信度、建议接受状态等列；来源隔离主要靠 tag service，不能直接照搬为 Kinshoko 的自动标签建议。不同本地 file domain 也共用同一套 hash 定义，不能把一个客户端里的文件域默认看作完整独立资料库。[siblings][h-siblings]、[标签映射][h-mappings]、[文件域状态][h-storage]

笔记按 `file_notes(hash_id, name_id, note_id)` 保存；`NoteImportOptions` 对同名不同正文有 replace/ignore/append/rename 四种处理，默认 rename，并查正文是否已在其他名称下出现，避免重试制造越来越多相同笔记。这比“目标不空就忽略源备注”更值得用作冲突与重导样本。这里的笔记是命名文本；本轮检查的该表没有区域坐标。[笔记表][h-notes]、[冲突处理][h-note-options]

Hydrus 的 duplicate 关系不是“同字节仅一条记录”的同义词。`duplicate_files(media_id, king_hash_id)`、`duplicate_file_members(media_id, hash_id)` 可以把不同原文件放在一个关系组，alternate 与 false-positive 另记。`DuplicateContentMergeOptions` 决定标签、笔记、URL、rating、archive 等是否复制/双向汇合，允许针对视觉重复图处理元数据。这是对 Kinshoko“只对完全同原图汇合记录”之外的一种人工关系整理实践，不是建议自动把视觉相似图合成一条原图记录。[关系表][h-relations]、[元数据汇合][h-dupe-options]

**迁出有多条路径，关系不能靠普通旁车全保留。** TXT/JSON router 可交换标签、URL；此 commit 的代码还有命名笔记和时间戳节点，而同 commit 的 `advanced_sidecars.md` 开头仍写仅 tags/URLs，文档不能替代代码检查。HTA 是 hash↔tag 映射，HTPA 单独迁移 siblings/parents；普通文件旁车没有打包 duplicate/alternate 文件关系的节点。官方 `database_merging.md` 明确把这类关系的迁移交给 Client API 脚本，且客户端之间没有现成通用全量合并。没有执行往返测试，不能承诺各节点组合后无损。[router 取值][h-sidecar-read]、[router 写入][h-sidecar-code]、[旁车文档][h-sidecar-doc]、[HTA/HTPA][h-migration]、[数据库合并文档][h-merge-doc]

完整恢复主要依赖数据库与管理文件一起备份。内置 `_Backup` 先关闭数据库连接，复制数据库文件和默认 `client_files`，然后重开；跨盘分散存放时官方要求改用涵盖所有位置的备份。文档要求外部复制时关闭客户端，并避免把运行中的数据库直接交给持续云同步。这是备份文件集合和写入时机的具体限制，不证明客户端之间可以双向同步数据库。[备份代码][h-db]、[备份与云同步说明][h-install]

## 补充反例：Blombooru 与 LocalBooru

Blombooru 同 MD5 的 Booru 下载/导入直接返回 duplicate 409，逻辑备份恢复遇到已有 hash 则直接 skip；后者不把输入记录的新标签、来源等汇到旧记录。普通 `blombooru_media_tags(media_id, tag_id)` 没有来源、置信度或人工否定列，不能用标签关联表还原整理决定。[Booru 导入][b-import]、[备份恢复][b-restore]、[模型][b-model]

它的关系恢复方式有借鉴价值：备份用 `parent_hash` 指向父图，相册用 `media_hashes`，恢复先建图片，再连父图；相册先做 `json_id → db_id`，再连成员与层级。但是 `backup_full_db` 的 JSON **没有 `source/description` 和 tag implications**；恢复还把文件取 `archive_path` 的 basename 放入原图目录，同名用后缀避让。相册按名称映射到已有相册，同名不是稳定身份。所谓 full backup 在这个版本是明确的字段清单，不能当作全部 PostgreSQL 状态无损恢复。[备份字段][b-backup]、[三阶段恢复与文件路径][b-restore]

LocalBooru 默认 fast import 先查原路径，再用“大小＋首尾各 64KiB”快速哈希查重复，命中便返回；不会核对中间字节，且这条重复分支不增加新文件路径。`_complete_fast_import` 只补尺寸/pHash/缩略图，没有把这个 hash 换成全文件 hash；普通模式才有“同全文件 xxh64 添加新路径”的分支。这个例子直接反对用快速哈希证明“完全相同原图”。[两个导入分支][l-import]、[后台补全][l-tasks]

它的移动监听只调度新路径导入；清理缺失文件时，最后一条文件引用消失会删除图片与缩略图。因此“引用原目录”仍需要明确的移动追踪与元数据保留规则。其集合表在主数据库用 `collection_id/image_id/sort_order`，不能从该表证明它能引用所有目录数据库；迁移代码包含系统安装/portable 数据搬移与旧主库 `images/image_files` 的选择导入，尚未证实 per-directory 模型能完整往返，也未核实完整图片关系/旁车导出。[监听][l-watch]、[缺失清理][l-tracker]、[模型][l-model]、[迁移入口][l-migrate]

## 对 Kinshoko 当前选择的影响与待执行样本

独立资料库可隔开不同整理结果，但代价是合并时不能只拼平面标签；Monbooru 来源账目与 Hydrus 删除记录提供了具体可保存的信息。当前“合并产生新库、保留原库”没有从这些项目得到完整直接范例；保留既定选择，并验证新库是否保留贡献来源、如何处理否定决定及引用重映射。参考组独立保存、成员独立裁切/布局也没有被上述相册或图片批注替代：Monbooru 是图片级区域，Blombooru 是成员关系，LocalBooru 集合禁止同图重复入组，均与一次使用的裁切信息不同。

| 验证样本（未执行） | 它能逼出什么具体规则 |
|---|---|
| A、B 两库有同字节图片；A 的备注为“眼睛”，B 为“衣褶”；A 删过标签“侧脸”，B 正在使用；合并到 C 后再重导 A/B | 哪些字段汇合、哪些成为冲突；是否保留来源库；重导是否恢复被删标签。避免 Monbooru merge 只读标签、transfer 填空造成的默默遗漏，也不能把 Hydrus 的单 service 删除决定直接扩成跨库结论。 |
| 同视觉图分别是原 PNG、重编码 JPG、改过 EXIF 的文件；再加两份合法大 PNG，大小及首尾 64KiB 相同、中间字节不同 | 前三种字节不同须保留独立原图记录；后两份能检验快速哈希误判。pHash、站点 MD5 声明和文件名都不能代替全文件相同判断。 |
| 原图已有区域批注与两个参考组成员；在原路径用另一尺寸图片替换它 | 图记录是否改指新内容，原 SHA 是否仍可定位，旧裁切是否失效；Monbooru 保 ID 换 SHA 是应显式接受或拒绝的行为。 |
| 导入任务中断后重试；重拉来源撤回标签；用户编辑过网站批注又重拉；同名冲突备注重导两遍 | 重试不增加相同记录；来源撤回和人工删除分开；用户改框是否被覆盖；备注 rename 不累积相同副本。 |
| 只导出关系的子图、参考组含两个资料库图片、同图在组里出现两次使用；随后重命名或复制来源库 | 是否包含全部依赖端点、保留两次成员和各自裁切；重导到新库后能否通过明确映射继续引用；缺图能否被点名列出。 |
| 移动/删除在“文件操作与 DB 提交”之间中断；备份时原文件盘离线；恢复只有一部分 DB 或只有原文件 | 是否可识别并恢复中间状态，能否区分失联与用户删除，备份结果能否明确标明未包含的文件；不能把 ZIP 成功生成当作资料库完整。 |

这些案例是用于检验既定选择的建议验证样本，不直接构成已采用的 Kinshoko 数据协议。未证实处集中在实际往返完整性、崩溃恢复、并发改图时的文件快照、以及参考组跨库依赖；本报告不对这些行为作稳定性承诺。

[m-config]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/config/config.go
[m-schema]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/db/schema.sql
[m-ingest]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/gallery/ingest.go
[m-sync]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/gallery/sync.go
[m-bootstrap]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/db/bootstrap.go#L317-L341
[m-tags]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/tags/image_tags.go
[m-annotations]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/gallery/annotations.go
[m-io]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/galleryio/io.go
[m-merge]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/galleryio/merge.go
[m-transfer]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/galleryio/transfer.go
[m-move]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/gallery/move.go
[m-delete]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/gallery/delete.go
[h-files]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/files/ClientFilesManager.py
[h-master]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/db/ClientDBMaster.py
[h-import]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/importing/ClientImportFiles.py
[h-seeds]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/importing/ClientImportFileSeeds.py#L1884-L2017
[h-storage]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/db/ClientDBFilesStorage.py
[h-mappings]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/db/ClientDBMappingsStorage.py
[h-tag-options]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/importing/options/TagImportOptions.py
[h-siblings]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/db/ClientDBTagSiblings.py
[h-notes]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/db/ClientDBNotesMap.py
[h-note-options]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/importing/options/NoteImportOptions.py
[h-relations]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/db/ClientDBFilesDuplicatesStorage.py
[h-dupe-options]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/duplicates/ClientDuplicates.py
[h-sidecar-code]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/metadata/ClientMetadataMigrationExporters.py
[h-sidecar-read]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/metadata/ClientMetadataMigrationImporters.py
[h-sidecar-doc]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/docs/advanced_sidecars.md
[h-migration]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/ClientMigration.py
[h-merge-doc]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/docs/database_merging.md
[h-db]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/db/ClientDB.py#L310-L377
[h-install]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/docs/getting_started_installing.md#L328-L375
[b-model]: https://github.com/mrblomblo/blombooru/blob/18dc659930fd7bc13fd1dc750b2fc0bc3f5eed6a/backend/app/models.py
[b-hash]: https://github.com/mrblomblo/blombooru/blob/18dc659930fd7bc13fd1dc750b2fc0bc3f5eed6a/backend/app/utils/media_processor.py#L14-L39
[b-import]: https://github.com/mrblomblo/blombooru/blob/18dc659930fd7bc13fd1dc750b2fc0bc3f5eed6a/backend/app/routes/booru_import.py#L160-L176
[b-backup]: https://github.com/mrblomblo/blombooru/blob/18dc659930fd7bc13fd1dc750b2fc0bc3f5eed6a/backend/app/routes/admin/backup.py#L58-L124
[b-restore]: https://github.com/mrblomblo/blombooru/blob/18dc659930fd7bc13fd1dc750b2fc0bc3f5eed6a/backend/app/utils/backup.py
[l-model]: https://github.com/DonutsDelivery/LocalBooru/blob/79ad5ff0b634ace3f74d28651311381b03f8fc1e/api/models.py
[l-import]: https://github.com/DonutsDelivery/LocalBooru/blob/79ad5ff0b634ace3f74d28651311381b03f8fc1e/api/services/importer.py
[l-tasks]: https://github.com/DonutsDelivery/LocalBooru/blob/79ad5ff0b634ace3f74d28651311381b03f8fc1e/api/services/task_queue.py#L463-L527
[l-watch]: https://github.com/DonutsDelivery/LocalBooru/blob/79ad5ff0b634ace3f74d28651311381b03f8fc1e/api/services/directory_watcher.py#L147-L173
[l-tracker]: https://github.com/DonutsDelivery/LocalBooru/blob/79ad5ff0b634ace3f74d28651311381b03f8fc1e/api/services/file_tracker.py#L289-L334
[l-migrate]: https://github.com/DonutsDelivery/LocalBooru/blob/79ad5ff0b634ace3f74d28651311381b03f8fc1e/api/migration/import_runner.py
