# 补充项目的数据实践

核查日期：2026-10-01。补查上一轮候选中的 ImoutoRebirth、VIOLET 与 anime-illust-image-searcher。以下是固定提交的静态源码核查，未运行程序或恢复真实图库；本地快照的相关文件已按 Git blob 哈希与 GitHub tree 对照一致。

## ImoutoRebirth：记录身份、去重与来源分别保存

版本：[67e185c](https://github.com/ImoutoChan/ImoutoRebirth/tree/67e185cfa6ec30f11534c167fae18f203c25740f)。

- 新图片获得独立生成的 GUID；`CollectionFile` 分开保存 `Id / CollectionId / Path / Md5 / OriginalPath`，重命名只改路径。数据库以资料集与 MD5 约束未移除记录的重复，另存 `IsRemoved`。[创建记录](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Room/ImoutoRebirth.Room.Application/Cqrs/SaveNewFileCommand.cs)、[记录模型](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Room/ImoutoRebirth.Room.Domain/CollectionFile.cs)、[数据库约束](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Room/ImoutoRebirth.Room.Database/RoomDbContext.cs)
- 标签关联有 `Source`；刷新非人工来源时先替换该来源的标签与备注，保留其他来源，包括人工添加。区域备注保存位置、尺寸、来源与外部备注 ID。[刷新行为](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Lilin/ImoutoRebirth.Lilin.Domain/FileInfoAggregate/FileInfo.cs)、[标签身份](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Lilin/ImoutoRebirth.Lilin.Domain/FileInfoAggregate/FileTag.cs)、[区域备注](https://github.com/ImoutoChan/ImoutoRebirth/blob/67e185cfa6ec30f11534c167fae18f203c25740f/Source/ImoutoRebirth.Lilin/ImoutoRebirth.Lilin.Domain/FileInfoAggregate/FileNote.cs)

对 Kinshoko 的启发：来源信息应跟随标签关联与区域备注。保留人工添加和记住人工拒绝是两种能力；上述刷新逻辑本身不能证明后者已经实现。

## VIOLET：有备份入口，还要逐字段核对恢复

版本：[2b742ca](https://github.com/kyloris0660/VIOLET/tree/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d)。

- 图片记录分别存 ID、路径与唯一内容哈希；标签关联存来源、置信度、锁定和建议状态。[模型](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/models.py)
- `/backup/full` 将原文件、标签 CSV、`backup.json` 打进 ZIP；JSON 包含图片标签名称、父图哈希及相册成员和层级。恢复先导入图片，再以哈希关联父图和相册，以旧相册 ID 到新 ID 的映射恢复层级。[导出](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/routes/admin/backup.py)、[恢复](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/utils/backup.py)
- 该导出没有序列化 `Media.source / description`，标签关联也只导出名称，没有带走来源、置信度、锁定和建议状态。恢复插入标签关联时仅提供图片 ID 与标签 ID；因此这些状态无法通过此路径原样往返。恢复遇到已有图片哈希会跳过该条图片，不能据此承诺合并其元数据。以上是这条代码路径的字段对照结果，不是实际恢复测试。[模型](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/models.py)、[导出字段](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/routes/admin/backup.py)、[导入分支](https://github.com/kyloris0660/VIOLET/blob/2b742ca3e49d4b7d361300e98e0b2d9c1a0eb63d/backend/app/utils/backup.py)

对 Kinshoko 的启发：借鉴恢复时的关系映射，但不能照搬“full”名称作为完整性保证。我们的恢复为独立库、合并生成新库，也不等同于这个导入现有数据库的流程。

## anime-illust-image-searcher：检索索引有自己的身份

版本：[32dc1a7](https://github.com/ryogrid/anime-illust-image-searcher/tree/32dc1a7ad3d4b8e57655c35abbff55777dd12976)。

- 从 UTF-8 的“文件路径 + 标签”文本生成检索文件及 Doc2Vec/BM25 数据；文档 ID 按输入行分配，少于三个标签的条目不进入这条索引生成路径。增量更新加载旧词典和模型，BM25 生成只计入词典已有标签。[生成代码](https://github.com/ryogrid/anime-illust-image-searcher/blob/32dc1a7ad3d4b8e57655c35abbff55777dd12976/genmodel.py)
- 检索结果通过索引行里的路径打开原图；Windows 的结果导出使用 Shift-JIS，并捕获写出异常。它不是保存资料库和参考组关系的往返格式。[读取与导出](https://github.com/ryogrid/anime-illust-image-searcher/blob/32dc1a7ad3d4b8e57655c35abbff55777dd12976/webui.py)

对 Kinshoko 的启发：检索行号不能承担参考组的长期来源身份；搜索缓存需要能从资料库记录重建。中文文件名、逗号和标签变更也应纳入验证，不能只测英文示例路径。

这些补充证据与 Eagle、图库和参考板的主调查合并见 [数据实践汇总](data-model-practices.md)。
