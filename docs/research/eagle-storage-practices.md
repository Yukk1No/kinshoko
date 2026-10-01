# Eagle 数据形状与公开导入实践

核查日期：2026-10-01。依据官方 API 文档、固定版本公开源码和公开样本；只读核查，未运行下载来的程序，也未读取用户资料库。沿用 [ADR 0001](../adr/0001-eagle-import-boundary.md) 的初期只读导入、随后独立管理边界；以下是兼容事实和验证项，不新增产品决定。

## 证据版本

| 实现 | 核验范围与固定版本 |
|---|---|
| fanyang89/eaglexport | 原文件导出器，commit [34f93e41](https://github.com/fanyang89/eaglexport/tree/34f93e41ccd7a28412addb146a68613b3dc2f254) |
| naamiru/eagle-webui | 直接读盘的浏览器，commit [68d9ff89](https://github.com/naamiru/eagle-webui/tree/68d9ff891649d2dd92564b7d3fe456f9e1adeae6)，附 `applicationVersion: "4.0.0"` 样本 |
| Stef4678/eaglepack-importer | 实际把 `.eaglepack`/压缩资料库导入 Obsidian 的实现，发布标签 [0.0.2](https://github.com/Stef4678/eaglepack-importer/tree/de093e4315cf39a6519ced3bf3f609950bee32f3)，commit `de093e43` |

## 官方接口与观察到的磁盘结构

官方 Web API 需要 Eagle 正在运行。V2 要求 Eagle 4.0 Build 21+，素材列表默认每页 50、最多 1000；`library/info` 面向当前打开的资料库，另有历史列表和切库接口。它提供读取语义，不代表一次列表请求包含全库，也未在这些页面承诺分页期间的固定快照。[V2 说明](https://developer.eagle.cool/web-api)、[Library API](https://developer.eagle.cool/web-api/api/library)

官方 Item API 公开 `id/tags/folders/url/annotation/isDeleted/modificationTime`；`folders` 是文件夹 ID 数组，`url` 是来源链接。Plugin API 另外公开原文件、缩略图和单项 JSON 的路径，以及 `importedAt/modifiedAt`；官方建议通过 API 修改，避免直接写资料库文件。本次没有找到官方承诺长期稳定的离线 JSON 格式规范。[Web Item API](https://developer.eagle.cool/web-api/api/item#properties)、[Plugin Item API](https://developer.eagle.cool/plugin-api/api/item#woenk)

公开 4.0.0 样本和读取器采用以下结构，文件夹分类存于 JSON，而非对应的物理目录；原文件与缩略图分别存放。下图用 `photo` 缩写样本的长文件名。[样本根 JSON](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library/metadata.json)、[单项目录](https://github.com/naamiru/eagle-webui/tree/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library/images/MGMYDH18YSIS1.info)

```text
<资料库>.library/
├── metadata.json                  # folders 嵌套 children；另有 smartFolders 等
├── mtime.json                     # ID → 数值，另有 all
└── images/MGMYDH18YSIS1.info/
    ├── metadata.json              # 单项元数据
    ├── photo.jpg                  # 原文件
    └── photo_thumbnail.png        # 缩略图
```

单项样本的 `btime/mtime` 相同，但 `modificationTime/lastModified` 与它们不同；根 `mtime.json` 的同 ID 值另为 `1760228119055`。应保留来源字段名与原值，不能把文件系统时间、单项时间和根索引数值合并。官方 `importedAt/modifiedAt` 与这些离线字段的逐一对应尚未验证。[单项样本](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library/images/MGMYDH18YSIS1.info/metadata.json)、[mtime 样本](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library/mtime.json)

```json
{
  "id": "MGMYDH18YSIS1",
  "folders": ["MGH4XZ1OQCGZD"],
  "btime": 1756571097667,
  "mtime": 1756571097667,
  "modificationTime": 1760228118908,
  "lastModified": 1760409426491,
  "order": { "MGH4XZ1OQCGZD": "1759876940271.5" }
}
```

根样本用 `tagsGroups`，V2 `library/info` 示例用 `tagGroups`。这是不同输入来源的实际拼写差异，不能直接认为 Web API 对象与磁盘 JSON 可互换。公开样本也只是裁剪样本：`mtime.json` 列有 23 个 ID，仓库只提供一个 `.info` 项目；不能据此验证索引完整性或真实全库导入。[样本目录](https://github.com/naamiru/eagle-webui/tree/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library)、[V2 library/info](https://developer.eagle.cool/web-api/api/library#info)

## 导入时需保持的关系

| 信息 | 已确认的形状与保留重点 |
|---|---|
| 来源身份 | 保存来源资料库与原 `item.id` 的关联。官方只描述 item ID 唯一，未承诺跨库唯一；旧官方示例同时出现 UUID 和较短 ID，宜按不透明字符串处理。[V1 库示例](https://api.eagle.cool/library/info) |
| 文件夹 | 保留每个文件夹 ID、名称、`children` 层级，以及素材的**全部** `folders` ID；名称路径不足以区分同名文件夹。样本还显示 `coverId` 指向素材，`order` 按文件夹 ID 记录该素材的排序值。[根样本](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library/metadata.json)、[单项样本](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library/images/MGMYDH18YSIS1.info/metadata.json) |
| 标签与库级整理 | 素材 `tags` 是名称数组；库的标签组、智能文件夹条件、快速访问是另一些记录，不能由图片标签数组还原。[V1 library/info](https://api.eagle.cool/library/info)、[Tag Group API](https://developer.eagle.cool/web-api/api/tag-group) |
| 来源与备注 | 分别保留 `url` 与整图 `annotation`。官方来源 URL 示例可以是 Pinterest 页面，不能把它当作原图下载地址。[V1 item/info](https://api.eagle.cool/item/info) |
| 局部评论 | Build 22+ 的官方 `getComments` 返回图像矩形评论 `id/x/y/width/height/annotation/lastModified`，或视频时间评论；它与整图备注不同。保留评论所属素材、评论 ID 和全部几何字段；这些字段没有公开人物或局部标签关联。[getComments](https://developer.eagle.cool/web-api/api/item#get-comments) |
| 删除状态 | `isDeleted` 官方表示在回收站；它与元数据、原文件缺失是不同情况。`deletedTime` 仅见于本次导出器类型定义，不能据此声称所有版本都有它。[官方属性](https://developer.eagle.cool/web-api/api/item#properties)、[读取器类型](https://github.com/fanyang89/eaglexport/blob/34f93e41ccd7a28412addb146a68613b3dc2f254/eaglexport/types.go#L25) |
| 文件与显示 | 原文件、缩略图、`name/ext/size/width/height` 需对应到同一素材；仅能显示缩略图不足以证明原文件迁移成功。区域评论还需对应原图尺寸与方向。[Plugin 路径属性](https://developer.eagle.cool/plugin-api/api/item#woenk) |

## 公开实现实际保留了什么

**eaglexport 是原文件导出，无法承担完整元数据迁移。** 它枚举 `mtime.json` 的键，按 `images/<id>.info/<name>.<ext>` 找原文件，跳过 `isDeleted`；输出为平铺文件或一个智能文件夹分类路径，没有写出 Eagle JSON、原 ID、标签、来源、备注或全部文件夹关系。不同 ID 的同名素材可能落到同一目标路径。解析或原文件打开失败会返回错误；并发导出可能已经写出其他文件。[export.go](https://github.com/fanyang89/eaglexport/blob/34f93e41ccd7a28412addb146a68613b3dc2f254/eaglexport/export.go#L49)、[JSON 解码](https://github.com/fanyang89/eaglexport/blob/34f93e41ccd7a28412addb146a68613b3dc2f254/eaglexport/json.go)

它的重导 history 按源路径与文件系统 mtime 判断是否已复制，无法感知只改标签、备注的变化。另有明确的静态风险：`copyFile` 在检查 history 前用 `O_TRUNC` 打开目标，随后若 history 命中便跳过复制；按此执行顺序，重导可留下空文件。此风险尚未运行复现，因此不能把 history 函数视为可靠重导流程。[copyFile](https://github.com/fanyang89/eaglexport/blob/34f93e41ccd7a28412addb146a68613b3dc2f254/eaglexport/export.go#L129)、[history.go](https://github.com/fanyang89/eaglexport/blob/34f93e41ccd7a28412addb146a68613b3dc2f254/eaglexport/history.go)

**eagle-webui 是直接读盘浏览，保留了主要关系，但有字段丢失。** 它只接受 `applicationVersion` 以 `4.` 开头，根 JSON 或 mtime 校验失败会中止；单项缺失、坏 JSON 或校验失败则记日志并跳过。它也仅枚举 mtime 键，并未验证 `all` 与实际项目数量一致。文件夹归属和层级进入内存，回收站另可浏览；原图请求仍读取原 Eagle 路径，未把文件迁入独立资料库。[导入及单项错误处理](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/data/library/import-metadata.ts#L233)、[Store](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/data/store.ts#L67)、[文件读取](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/app/api/items/utils/image-handler.ts#L7)

它的 schema 使用 `additionalProperties: true`，归一化却构造新对象：未知字段、根 `quickAccess/tagsGroups` 没有进入返回结果；缺数值默认变成 `0`。评论最终只有 `{id, annotation}`，即使输入带坐标、时间点或修改时间也会丢失；`fontMetas` 也只剩 `numGlyphs`。原文件选择取目录中第一个非缩略图、非 `metadata.json` 文件，未校对 `name/ext` 或唯一候选。[返回对象](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/data/library/import-metadata.ts#L255)、[归一化](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/data/library/import-metadata.ts#L367)、[评论映射](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/data/library/import-metadata.ts#L426)

**EaglePack Importer 0.0.2 有实际独立导入代码，输出仍有损。** 它按 JSON 内容识别库头、`pack.json.images` 和单项 JSON；接受外层嵌套目录，无单项 JSON 时可从 pack 列表补读，完全无元数据时才尝试 `.info` 目录推断。坏 JSON 给 warning；找不到 pack 中素材目录仍保留无文件条目。同 ID 去重保留先遇到的记录，未比对多个元数据副本是否一致。[解析器](https://github.com/Stef4678/eaglepack-importer/blob/de093e4315cf39a6519ced3bf3f609950bee32f3/main.js#L546)

它复制文件并生成 Markdown，物理放置只选 `folders[0]`；全部可解析归属仅写成名称路径，原文件夹 ID、排序、智能文件夹、标签组不输出。它在内存读入 `comments/order/mtime/lastModified`，生成笔记却没有写出这些字段或未知字段；Eagle 原标签名称另行保留，Obsidian 标签则经过字符替换。[文件夹放置](https://github.com/Stef4678/eaglepack-importer/blob/de093e4315cf39a6519ced3bf3f609950bee32f3/main.js#L736)、[归一化](https://github.com/Stef4678/eaglepack-importer/blob/de093e4315cf39a6519ced3bf3f609950bee32f3/main.js#L458)、[笔记输出](https://github.com/Stef4678/eaglepack-importer/blob/de093e4315cf39a6519ced3bf3f609950bee32f3/main.js#L808)

它跳过回收站素材，重导按目标路径选择 skip/overwrite，没有按 Eagle ID 查找既有笔记；改名或换文件夹会换目标路径。overwrite 先删旧文件再写新文件，单项失败会继续，但已有写入不会回滚。原文件缺失而仅有缩略图时仍可生成展示笔记，因此成功笔记数不能作为原文件完整导入的证据。公开测试主要覆盖纯解析和文本生成；名为 deleted 的测试实际上只包含未删除素材，未验证真实删除导入过程。[导入循环](https://github.com/Stef4678/eaglepack-importer/blob/de093e4315cf39a6519ced3bf3f609950bee32f3/main.js#L1201)、[该测试](https://github.com/Stef4678/eaglepack-importer/blob/de093e4315cf39a6519ced3bf3f609950bee32f3/tests/run.mjs#L268)

## 可借鉴边界与待验证案例

从这些源码可借鉴输入识别、分项错误报告、原文件与缩略图分辨、文件夹 ID 到层级的解析；不能照搬其归一化作为“元数据已完整保留”的依据。对 Kinshoko 的导入评审，原始 JSON 与已解释字段分开记录、记录来源版本和每项成功/跳过/缺失原因，有助于后续补读未知字段。这是根据上述有损实例提出的验证方向。

| 案例 | 需要核验的结果 |
|---|---|
| 多库与重导 | 两库同 ID、复制库、同名原文件、素材改名/换归属、只改标签备注、导入中断后重试；应能说明是否新建、更新、跳过及其依据，具体策略仍待产品确定。 |
| 组织关系 | 多重归属、同名文件夹、深层 children、悬空 folders/coverId/order、标签组与智能文件夹条件；不能以一个物理路径代替全部归属。 |
| 局部参考 | Build 22 的实际评论与离线 JSON 对照；验证坐标基准、EXIF 方向、透明边缘、越界矩形。保留评论不自动等于把它变成 Kinshoko 参考视图，转换语义尚待确定。 |
| 文件缺失 | 缺单项 JSON、缺原文件、只剩缩略图、目录有多个原文件候选、纯书签；需区别回收站状态和丢失，不能只因预览可见而宣布迁移成功。 |
| 格式变化 | 3.x/4.x 与后续版本、未知字段、字符串排序值、缺字段、错误类型、重复 ID；核验根 mtime 与目录扫描的覆盖情况，不能把读取器的索引假设当官方保证。 |
| 一致性 | Eagle 写入、改名或同步期间读取：库头、mtime、单项 JSON、原文件可能分次读取。上述实现没有展示跨这些文件的固定快照；官方分页接口也未声明跨页快照。需验证变化检测与失败重试，避免把同一次导入误记为一个已证明一致的版本。 |
