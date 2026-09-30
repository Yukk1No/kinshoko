# Eagle 兼容性事实核查

核查日期：2026-10-01。仅核对公开文档与公开读取代码；未读取用户真实图库，也未测试实际导入。

## 官方接口公开的数据

| 信息 | 公开字段或接口 |
|---|---|
| 素材 ID | `item.id` |
| 图片级标签 | `item.tags: string[]` |
| 文件夹归属 | `item.folders: string[]`，可有多个文件夹 ID |
| 文件夹层级 | Folder 的 `id/name/children`；Library 的顶层 `folders` |
| 来源链接 | `item.url`，不保证是原图下载地址 |
| 整图备注 | `item.annotation` |
| 原文件位置 | Plugin API 的 `filePath/fileURL`；缩略图另有路径 |
| 单项元数据位置 | Plugin API 的 `metadataFilePath` 指向对应 `metadata.json` |
| 区域评论 | V2 `getComments` 返回 `id/x/y/width/height/annotation/lastModified` |

来源：[Plugin Item API](https://developer.eagle.cool/plugin-api/api/item)、[Web Item API](https://developer.eagle.cool/web-api/api/item)、[Folder API](https://developer.eagle.cool/web-api/api/folder)、[Library API](https://developer.eagle.cool/web-api/api/library)。

## 图片标签与区域评论

Eagle 已有局部框选评论，不能把它描述为只有整图备注。官方 [Tag API](https://developer.eagle.cool/web-api/api/tag) 统计使用标签的素材数，[Tag Group API](https://developer.eagle.cool/web-api/api/tag-group) 组织标签名称；本次公开区域评论 schema 没有列出 `tags`、人物 ID、发色或发型等字段。

本次未发现“人物 → 区域 → 属性标签”的结构化关联接口。仅凭整图标签，不能确定不同属性是否属于同一人物；这不代表 Eagle 完全没有区域标注能力。

## 两条读取路线

- **调用正在运行的 Eagle**：[Web API V2](https://developer.eagle.cool/web-api) 要求 Eagle 4.0 Build 21+；同机请求无需认证，跨设备请求需 token，接口面向当前打开的图库。列表需要分页。区域评论接口要求 Build 22+；[官方发布说明](https://www.eagle.cool/blog/post/eagle4-build22) 日期为 2026-03-27。
- **直接读取磁盘库**：公开读取代码处理根 `metadata.json`、`mtime.json` 与 `images/<id>.info/metadata.json`，并从相应 `.info` 目录取原文件。证据包括 [2024 年导出器](https://github.com/fanyang89/eaglexport/blob/34f93e41ccd7a28412addb146a68613b3dc2f254/eaglexport/export.go)、[2025 年读取器](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/data/library/import-metadata.ts) 与 [4.0.0 图库头样本](https://github.com/naamiru/eagle-webui/blob/68d9ff891649d2dd92564b7d3fe456f9e1adeae6/docs/sample-library/metadata.json)。本次未找到官方承诺永久稳定的磁盘格式规范。

持续接入要跟踪原库的可访问性与变化；一次性导入则要迁移原文件与组织关系。导入范围需分别讨论来源 ID、标签、所有文件夹归属与层级、来源链接、整图备注、区域评论与删除状态。只导出图片文件不能自动保留这些关系。

## 待验证边界

- 用户实际 Eagle 版本与图库字段完整性。
- 区域坐标的基准，以及 EXIF 旋转与显示变换的对应关系。
- Eagle 写入或云盘同步期间，直接读盘的数据一致性。
- 不同版本的磁盘格式兼容性。上述 2025 年读取器会将评论归一化为 `id/annotation`，丢失区域坐标，不能直接照搬作为完整导入实现。

Eagle 另有依赖 AI Search 插件的 [AI Search API](https://developer.eagle.cool/web-api/api/ai-search)，本次未验证其二次元发色、发型或多人属性匹配效果。
