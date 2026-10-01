# 数据实践调查：给 Kinshoko 建模的依据

核查日期：2026-10-01。追查已有候选的官方文档与固定提交源码，另补 BeeRef 和一个实际 EaglePack 导入器；未运行候选应用或做真实资料库往返测试。以下区分实现事实与建模建议。

多资料库、独立参考组、成员各自保存裁切与布局，可以继续作为需求讨论基础。现有 [层级图](../discovery/data-hierarchy.md) 表达归属；它还没有定义图片身份、导入保留范围、合并冲突和参考组依赖，不能据此直接定文件格式。本调查不修改已确认的定义与两篇 ADR。

## 已有项目怎样存

| 项目 | 核验到的实践 | 对我们最有用的边界 |
|---|---|---|
| Eagle | 原文件与缩略图按 item ID 放置；库级和单项 JSON 保存整理信息；一个素材可归属多个文件夹 ID。[官方 Item](https://developer.eagle.cool/plugin-api/api/item)、[磁盘样本](https://github.com/naamiru/eagle-webui/tree/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library) | 分类关系不能直接变成唯一磁盘路径；公开 API 对象与磁盘 JSON 也不是同一格式。 |
| Monbooru / Hydrus | 原文件与数据库关系分别管理；Monbooru 区分完整与轻量导出，Hydrus 单独记录已删除标签。[Monbooru 导出](https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/galleryio/io.go)、[Hydrus 导入过滤](https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/importing/options/TagImportOptions.py) | 图片去重、元数据迁移和人工拒绝都要有各自规则。 |
| Blombooru / VIOLET | 原文件配数据库；逻辑恢复用图片哈希和旧/新相册 ID 映射重建关系，但同哈希图片会跳过，部分模型字段未进入备份。[VIOLET 导出](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/routes/admin/backup.py)、[恢复](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/utils/backup.py) | 可以借鉴关系映射，不能借“full backup”名称承诺完整恢复。 |
| Project Curator | 索引用户文件，数据库存当前路径与哈希；同路径换内容会复用记录 ID。[导入分支](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/import.rs) | 能索引和显示图片，不代表资料库可以完整搬走；复用 ID 还可能改变旧局部参考的对象。 |
| BeeRef | 板文件自持图片与实例布局；复制成员可分别裁切；嵌图由解码图重新编码。[保存](https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/fileio/sql.py)、[实例和编码](https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/items.py) | 独立成员状态有现成实践；自包含板文件仍可能不保留原图字节。 |
| Nephele | 官方声明直接兼容 Eagle，自建索引，并保存板上位置、大小和视口；公开组件可核验部分交换字段，桌面板格式仍未知。[Eagle 说明](https://nephele.arisfusion.com/zh/docs/eagle)、[参考板](https://nephele.arisfusion.com/zh/docs/moodboard)、[公开范围](https://github.com/CreatorAris/nephele-core-audit/blob/ccd0711d266a2a5ee0cd2ada9c309e14d2e51e94/README.md) | 继续作为重要产品参考；不能把客户端协议或安全子集当成完整持久化实现。 |

LocalBooru 的快速去重、ImoutoRebirth 的独立记录 ID 与来源元数据、anime-illust-image-searcher 的路径索引另见下方笔记。这些实现解决的边界不同，没有一个能直接替我们确定全部数据规则。

## 六个需要落实的区别

1. **兼容 Eagle 要列出保留范围。** 只复制原图会丢整理关系；eagle-webui 的评论归一化只剩 ID 与文字，EaglePack Importer 的笔记也没有输出局部评论。这些都是实际有损路径。建议分别列出原文件、来源 ID、全部文件夹归属、标签、URL、整图备注、区域评论、回收站及库级整理的处理方式；暂未支持的字段应可辨认，不能悄悄丢掉。[评论映射](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/data/library/import-metadata.ts#L426)、[笔记生成](https://github.com/Stef4678/eaglepack-importer/blob/de093e4315cf39a6519ced3bf3f609950bee32f3/main.js#L808)
2. **记录 ID、来源 ID、路径、内容哈希各有用途。** ImoutoRebirth 分开保存这些信息；Curator 却允许同路径的新内容继承旧记录 ID。Eagle 文档也未承诺 item ID 跨资料库唯一。建议 Kinshoko 明确“改名/搬库”和“更换图片内容”的区别，并连同来源库保存导入身份；如何关联图片版本还未决定。[创建记录](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Room/ImoutoRebirth.Room.Application/Cqrs/SaveNewFileCommand.cs)、[Curator 更新](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/import.rs#L353-L424)、[Eagle ID 属性](https://developer.eagle.cool/web-api/api/item#properties)
3. **快速判重不能自动证明原图完全相同。** LocalBooru 快速导入使用大小与首尾片段的哈希；Curator 读文件失败时也会降级为局部哈希。我们的完全相同原图合并规则需要完整字节核验，不能把候选判重或感知相似度当作最终依据。[LocalBooru 导入](https://github.com/DonutsDelivery/LocalBooru/blob/79ad5ff0b634ace3f74d28651311381b03f8fc1e/api/services/importer.py)、[Curator 哈希](https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/import.rs#L136-L158)
4. **人工添加与人工拒绝要分别保留。** 按来源刷新可保留人工添加；Hydrus 还在导入时过滤已删除标签。我们已确认人工纠错优先，因此重跑模型、重导 Eagle 和合并资料库都需要验证拒绝是否仍有效。[按来源刷新](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Lilin/ImoutoRebirth.Lilin.Domain/FileInfoAggregate/FileInfo.cs)、[删除过滤](https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/importing/options/TagImportOptions.py)
5. **导出、恢复、合并保留的数据未必相同。** Monbooru 完整导出含标注与关系，但 merge 只汇入图片与标签；Blombooru/VIOLET 的恢复遇到已有哈希直接跳过图片。我们的 A+B→新 C 需要独立规定元数据冲突及旧引用怎样接到新记录，不能只做文件去重。[完整导出](https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/galleryio/io.go)、[合并](https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/galleryio/merge.go)、[VIOLET 恢复](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/utils/backup.py)
6. **参考组文档、可携带的包、原图库备份分别验收。** BeeRef 可以脱离原路径打开，但嵌图被重编码；Nephele 的板导出也有只恢复图片、重排布局的降级。跨库参考组要决定来源缺失和打包行为，不能以“还能看到图”认定原图、裁切、布局与元数据均已保全。[BeeRef 编码](https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/items.py#L216-L232)、[Nephele 导入导出说明](https://nephele.arisfusion.com/zh/docs/moodboard)

这些区别支持继续使用现有领域术语，但要求补充操作规则。具体数据库、JSON 格式、目录布局、远端后端和同步协议仍未选定。候选中的目录监听、路径恢复或手机访问，也不足以证明已经解决两台设备离线修改同一资料库后的合并；备份与持续同步仍按 [roadmap](../discovery/roadmap.md) 分别规划。

## 先用小样本约束规格

下一步应先做 Eagle 导入验证，再确定存储规格。优先准备下列可核对的小样本；它们尚未执行，也不替代缺失行为和冲突处理的产品决定。

| 样本 | 需要观察或决定的结果 |
|---|---|
| 同一图片属于两个同名文件夹，带 URL、整图备注和局部评论 | 逐字段说明导入结果，确认所有归属和评论几何信息；不能用一个输出路径代替全部关系。 |
| 只改标签后重导；改名后重导；导入中断后重试 | 按什么来源身份辨认已有项；哪些数据更新，哪些人工整理保留；每项失败是否可重试。 |
| 同图在一个组中两次裁切，再用于另一组 | 各成员的裁切与布局独立；图片去重不能顺便去掉成员。 |
| A/B 有完全相同原图，但备注与人工标签决定相反，合并为 C | 原图合并符合已定规则；冲突如何保留或让用户选择，旧组引用怎样迁移。 |
| 搬库、拔掉源盘、在同路径换另一张同大小图 | 区分位置变化、来源不可用和内容变化；明确恢复连接与缓存刷新的行为。 |
| 备份恢复为新库，或导出跨库组在另一台机器打开 | 分别核对原文件字节、整理结果、成员和布局；包是否带素材、带哪些元数据仍需决定。 |

证据笔记：

- [Eagle 数据结构与导入器](eagle-storage-practices.md)：公开样本、字段差异、重导及丢失路径。
- [图库存储与元数据](library-storage-practices.md)：Monbooru、Hydrus、Blombooru、LocalBooru。
- [资料库与参考板](reference-board-practices.md)：Curator、Nephele、BeeRef 的持久化与依赖。
- [补充项目](supplementary-data-practices.md)：ImoutoRebirth、VIOLET、anime-illust-image-searcher。
