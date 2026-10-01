# 资料库与参考板的持久化实践

调查日期：2026-10-01。仅核对官方文档和源码，未运行候选应用、下载模型或做文件往返实测。沿用 `GLOSSARY.md`、ADR 0001 的 Eagle 导入边界、ADR 0002 的独立跨库参考组；下文挑战未定规则，不修改领域模型。

**最有用的差异**：Curator 把文件内容、数据库记录和当前路径分开，但路径恢复实现不完整；BeeRef 让每次使用独立保存，并将图片嵌入板文件，但会重新编码；Nephele 的库与参考板能力值得对照，公开代码只能证明部分身份、采集和传输协议，不能证明桌面的保存格式。

## 固定范围

| 对象 | 固定版本或 commit | 可核验范围 |
|---|---|---|
| Project Curator | `f98f0b5c1941185ba781cb51963fefe023d42c42` | schema、导入、缺失检查、缓存、标签来源 |
| BeeRef | `v0.3.3` / `f53abad9c8ec34c12130464586d3750eea7279b7` | `.bee` schema、保存/载入、复制、裁切和导出 |
| Nephele Aura | `a3e1efc139d30e207c2fbd008235d4481770201b` | 手机端库记录、修改请求、投板协议 |
| Nephele Wisp | `18d6cdf55180bebf7973b056ee53c3bc8072cc13` | 网页来源字段、采集板身份、原图字节传输 |
| Nephele Core Audit | `ccd0711d266a2a5ee0cd2ada9c309e14d2e51e94` | 作者标为桌面 `0.8.1-beta` 的安全子集；不是库与参考板实现。[范围说明][N0] |

Nephele 文档按本次读取的版本说明记录：资源库与参考板页面最后更新 **2026-09-25**；Eagle 页面标注 **2026-06-29 / v0.6.1-beta.1**。参考板页面混有新版开发界面说明，不能把整页能力计入某个发布版。文档没有可固定的桌面源码 commit，以下明确标为“官方声明”。

## Project Curator：内容合并与文件路径不能互相代替

| 实际结构 | 字段与操作 | 含义 |
|---|---|---|
| 原文件 | 导入读取用户路径，不复制静态原图到应用目录；数据库保存 `current_filepath`。[导入][C2] | 是外部文件索引，不能把备份数据库当成备份原图。 |
| `images` | `id`、`sha256 UNIQUE NOT NULL`、`phash`、`current_filepath`、`os_file_id`、`mtime`、`deleted_at`；迁移另加 `folder_id`、`is_missing`、`width/height`、`note`。[schema][C1]、[迁移][C3] | 数字记录 ID、字节哈希、文件定位和缺失状态分别存在。`os_file_id` 有列不等于实际追踪文件移动。 |
| `folders` / `image_paths` | `folders(path UNIQUE,name)`；`image_paths(image_id,path,UNIQUE(image_id,path))`，迁移时从当前路径回填。[目录][C4]、[路径表][C5] | 在所查 `curator-db` / `curator-service` 源码中，未找到迁移之外对 `image_paths` 的读写。不能据表注释宣称已实现多路径恢复。 |
| metadata | `image_tags(image_id,tag_id,source_id,confidence,transaction_id,applied_at,is_deleted,deleted_at)`；`sources(name,type,manifest)`。[schema][C1] | `source_id` 的内置来源是模型或人工，如 Camie、CLIP、`user`，不是原图发布页的身份。[初始化][C6] |
| 文件名解析结果 | `image_parsed_metadata` 每图唯一，含 `artist,pixiv_id,twitter_id,datetime_iso,raw_matched,rule_id`。[解析表][C7] | 与字节哈希不同；该结构不是可追加的多发布来源记录。 |
| 应用目录 | `curator.db` 存关系数据；`vector_index.usearch` 存向量；`thumbnail-cache.db` 同时存缩略图与检测裁切 BLOB。[初始化][C6] | 派生缓存与原图分开。检测裁切用 `detection_id`，不是参考组成员裁切。[裁切表][C8] |

`import_paths_logic()` **先按 SHA-256 找记录，再按同一当前路径找记录**；`upsert_image_row()` 对已有记录写入新 `sha256/current_filepath/mtime`，保留已有 `folder_id`，复用 `id`。[匹配分支][C9]、[更新分支][C10]

- **同字节、不同路径**：合并为同一记录，当前路径改成这次导入路径；不意味着所有副本位置都被保留。删除该路径，即使另一份仍在，也可能被判缺失。
- **同路径、内容已替换**：找不到新哈希后按路径命中，仍复用原 ID，但哈希与内容已变。若参考组只记这个 ID，局部参考可能悄悄换成另一张图。这是对 Kinshoko 身份规则的反例，不建议照搬。
- 哈希正常路径读全文件字节；读取失败可降级为前 64 KiB 的哈希，打不开时甚至返回空字符串。降级值仍进入同一 `sha256` 列，不能把所有记录都视为已验证的完整字节身份。[哈希函数][C11]

`reconcile_missing_images()` 仅检查 `Path.exists()` 并更新 `is_missing`，不搜索新路径、不比对现存文件哈希；恢复也是检查当前路径再出现。存在、内容相同、路径已重定位是三件事。[缺失检查][C12] 所查 schema 与服务协议未发现参考板成员/布局模型或 Eagle 原生导入；检测框不能充当这一证据。未核实到整库 metadata 与依赖素材完整往返的导出流程。

**可借鉴**：显式缺失状态、可重建缓存、带来源的标签断言。**不能直接继承**：单一当前路径覆盖、多路径表尚未接入、同路径换内容复用 ID；“按哈希合并”也未证明已解决多个资料库的 metadata 冲突。

## Nephele：官方能力与公开代码分别能证明什么

桌面应用整体闭源；Core Audit 的固定快照只覆盖存证、水印和 AI metadata 检测等安全子集，没有公开库与参考板写盘实现。[范围说明][N0]

**官方声明**：Nimbus 库与 Eagle 兼容，可连接已有库或本地文件；切库不搬迁所有原图。Eagle 兼容页说明直接解析库级 `metadata.json` 与 `images/{id}.info/metadata.json`，原文件和缩略图在 `{id}.info/`；索引数据库由 Nephele 自建。文档列出读写标签、评分、注释、调色板与文件夹树，但没有公开该适配器实现。[资源库][N1]、[Eagle 说明][N2]

公开组件能核验的具体边界：

| 源码结构或协议 | 实际字段与行为 | 不能由此推出 |
|---|---|---|
| Aura `LibraryItem` / `LibraryFolder` | 接收 `id,name,ext,width,height,tags,star,annotation,url,size`；文件夹接收 `id,name,color,children`。缩略图缓存键是 `id:size`。[类型与缓存键][N3] | `id:size` 是缓存键，不是字节身份；同大小换内容不能靠这个键区分。这里没有证明跨资料库 ID 的命名空间或哈希去重。 |
| Aura 修改与入库请求 | `updateItem(itemId,{tags,star,annotation,url})`；`importFiles(urls,{folderId,tags,names,sourceUrls,requestId})` 分开传下载 URL、标题与发布来源 URL。[请求源码][N4] | 客户端发送字段不等于服务端正确、无损地写入全部 Eagle 字段；也没有证明 metadata 合并策略。 |
| Wisp 剪藏 | `reference.clip` 发送 `src_url,link_url,page_url,tab_title`，部分页面另取 `post_url/post_time`。采集板条目含 `url,page_url,pin_id,alt,width,height`，优先用 `pin_id`、缺少时用 `url` 去重。[剪藏源码][N5]、[采集字段][N11]、[判重][N6] | 发布条目身份、网页上下文与图片下载地址互不等同；按 URL/pin ID 去重不是按图片字节去重。 |
| Wisp 下载 | 选图候选的 `image_b64` 可仅为缩略图，并有 `is_thumb`；`fetchFullImages()` 另取原图字节，POST 到本地 ingest，返回 `used_url,bytes,mime`。[下载源码][N7] | 字段名含 image 不保证是原图；公开传输实现没有给出桌面入库后的哈希、原文件落点或板内引用格式。 |
| Aura 投板 | `BoardTarget` 有 `sessionId,name,boardSlot,expiresAt`；`sendToBoard()` 发送 `urls,sessionId,requestId`，结果分 `added/already/failed`。[目标类型][N8]、[请求源码][N4]、[结果处理][N9] | 临时投板会话不是已公开的持久化板 ID；`already` 也没有暴露按何种身份判重。 |

**参考板官方声明**：卡片位置、大小和视口会保存；可裁切并恢复；移除卡片与删除原文件分别操作；同素材通常不会重复入板。`.pur` 导入可保留图片/文字/布局，也可能降级为图片恢复后重新排布；导出 `.pur` 与画面 PNG 的保留范围不同，视频/模型需另外保管原文件。[参考板文档][N10]

**内部仍未知**：参考板到底嵌图、引用库 ID/路径还是两者混合；重复使用时裁切归谁；来源缺失或库移动后的重定位；原文件删除后板能否打开；板文件位置、版本 schema、跨库依赖清单、metadata 随包范围。公开安全子集中的 `.nep` 是存证容器，不能用它证明参考板打包。[公开范围][N0] 官方回收站说明也没有回答板内缺失引用的行为。[资源库][N1]

对 Kinshoko 的直接挑战：其“同素材通常不重复入板”与多个独立参考组成员不同，不能照搬投板判重；它选择持续读写 Eagle 原库，而 ADR 0001 选择导入后独立管理，兼容实现属于不同边界。源码所见的 `tags/star/annotation/url` 只是可核验交换子集，不能据此承诺 Eagle 全库无损兼容。

## BeeRef：自包含板文件也可能不是原图备份

`.bee` 是 SQLite 应用文件，`user_version=2`、`application_id=2060242126`，有两个核心表：[schema][B1]

```text
items(id PK, type, x, y, z, scale, rotation, flip, data JSON)
sqlar(name PK, item_id UNIQUE FK→items.id, mode, mtime, sz, data BLOB)
pixmap 的 data = {filename, opacity, grayscale, crop:[x,y,width,height]}
```

图片字节属于 **板内实例**：`SQLiteIO.insert_item()` 为每个新 item 编号，再写一份 `sqlar` 数据，文件名为 `编号-原 basename.png/jpg`；没有共享哈希素材表。`BeePixmapItem.create_copy()` 建新 item，复制裁切与变换，`save_id` 从空开始；复制后各成员可独立修改，但保存时每个成员都有自己的嵌图。[保存源码][B2]、[复制源码][B3]

**关键限制**：首次保存调用 `pixmap_to_bytes()`，从解码后的 QPixmap 重新编码 PNG/JPG；默认 `best` 将含透明通道或宽高均小于 500 的图存 PNG，其余存 JPG，质量参数为 90。它不是复制原文件字节，不能保证原 SHA-256、原格式或嵌入 metadata 不变。正常板保存不应用裁切/灰度，保留完整解码图；之后改布局只更新 `items`，不重写已有 BLOB。[编码与裁切][B4]、[默认配置][B5]、[更新源码][B2]

裁切是原图坐标中的 `[x,y,width,height]`；位置、层级、旋转、翻转和 `scale` 属于每个 item。显示尺寸由裁切宽高和 item 缩放派生；整板浏览缩放不是同一个字段。载入从 `sqlar.data` 解码，不根据 `data.filename` 回源；载入完成会重新适配整板视口。[item 数据][B4]、[载入][B6]、[打开完成][B7]

因此源文件移动、删除或修改不会影响已经保存的板中嵌图；代价是它不自动追随原图修订，也没有保留来源库关系的结构。删除成员后保存会删 `items/sqlar` 并 `VACUUM`，与删除外部原图无关。[删除与保存][B2] `.bee` 本身可携带图片和可编辑布局；PNG/JPG 是合成画面，SVG 导出把应用裁切/灰度后的图嵌为 base64，不能当原 metadata 的交换包。[导出][B8] 未发现 Eagle 库适配。

**可借鉴**：按使用实例保存裁切/变换，嵌图与实例属性分表，载入不依赖旧路径。**冲突**：Kinshoko 已选择参考图归资料库所有，BeeRef 则由板自持图片；可拿它测试导出包的自包含性，不能直接照搬成跨库在线引用，更不能以其重编码 BLOB 替代资料库原文件。

## 用这些实践检验既有选择

以下为未执行的验证样例，用于检验已有选择并暴露未定规则，不宣布新的领域决定。

| 样例 | 需观察或决定的结果 | 实践给出的反例或借鉴 |
|---|---|---|
| 库 A/B 合成新库 C；两库同一 PNG 分别写发布 URL、不同备注与人工纠错 | 已定判据：新 C 中完全相同的原图应合并。来源 URL、备注和纠错如何汇合？是否保留逐条来源与整理历史？ | Curator 模型来源可区分，但单一 `note` 与每图唯一解析结果未给出多库冲突解法；Nephele 分开传下载 URL 和来源 URL。 |
| 同图在同组使用两次，一次眼部、一次手部；再加入第二组 | 每个成员保有自己的裁切、位置和缩放，去重不能删成员 | BeeRef 新 item 保独立属性；Nephele 普通投板判重可能拒绝第二次使用，须单测。 |
| 文件改名/库根搬迁；同路径换另一张同大小图片 | 按什么身份恢复位置变更？内容更换是否产生新参考图/版本，旧局部如何处理？缓存能否识别这次变更？ | Curator 会复用同路径 ID，缺失检查只看存在；Aura `id:size` 缓存键不能识别等长替换。 |
| 拔掉库 A，删除库 B 的一张图，再打开跨库参考组 | 建议验证目标：缺失成员是否保留用途和布局，来源恢复后如何接回？移除成员与删除原图分别造成什么结果？ | Curator 有 `is_missing`；BeeRef 用嵌图避开失联，Nephele 的板内结果未知。跨库独立保存本身不保证可恢复。 |
| 导出组，带一个被使用三次的原图；在无原库的目录导入 | 建议验证目标：素材依赖是否去重？是否携带原始字节及哪些 metadata/来源身份？三次使用的独立裁切与布局能否恢复？ | BeeRef 自包含但每 item 嵌图且重编码。若将来承诺原图包，应以原字节哈希检验，不能仅核对画面相似。 |
| 用 Eagle 副本含重复内容不同 item ID、嵌套彩色文件夹、标签、评分、备注、来源、调色板，执行两次导入 | 哪些资料库字段完整保留、映射或缺失？同字节重复导入如何汇合 metadata、保护人工整理？导入与持续共写分别验收 | Nephele 官方声明与公开客户端字段是不同证据级别；PureRef 的仅图片恢复也说明“能打开”不等于布局/metadata 完整。 |

尚需确定的是：稳定身份与字节版本如何关联、多库整理冲突如何保留、来源不可用时保留什么、导出包是否携带原始字节，以及资料库字段完整保留的范围。三个项目都没有给出同时满足 Kinshoko 全部已定选择的现成保存模型。

[C1]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-db/migrations/0001_initial_schema.sql
[C2]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/import.rs#L427-L673
[C3]: https://github.com/FuouM/Project-Curator/tree/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-db/migrations
[C4]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-db/migrations/0003_add_folders.sql
[C5]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-db/migrations/0007_add_image_paths.sql
[C6]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/main.rs#L214-L310
[C7]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-db/migrations/0006_filename_parser.sql
[C8]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-media/src/crop_cache.rs#L33-L40
[C9]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/import.rs#L632-L655
[C10]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/import.rs#L353-L424
[C11]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/handlers/import.rs#L136-L253
[C12]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-service/src/worker.rs#L411-L479
[N0]: https://github.com/CreatorAris/nephele-core-audit/blob/ccd0711d266a2a5ee0cd2ada9c309e14d2e51e94/README.md
[N1]: https://nephele.arisfusion.com/zh/docs/library
[N2]: https://nephele.arisfusion.com/zh/docs/eagle
[N3]: https://github.com/CreatorAris/nephele-aura/blob/a3e1efc139d30e207c2fbd008235d4481770201b/app/%28tabs%29/index.tsx#L51-L79
[N4]: https://github.com/CreatorAris/nephele-aura/blob/a3e1efc139d30e207c2fbd008235d4481770201b/utils/websocket.ts#L534-L640
[N5]: https://github.com/CreatorAris/nephele-wisp/blob/18d6cdf55180bebf7973b056ee53c3bc8072cc13/extension/background/clip.js#L48-L174
[N6]: https://github.com/CreatorAris/nephele-wisp/blob/18d6cdf55180bebf7973b056ee53c3bc8072cc13/extension/background/handlers/reference_board.js#L417-L450
[N7]: https://github.com/CreatorAris/nephele-wisp/blob/18d6cdf55180bebf7973b056ee53c3bc8072cc13/extension/background/handlers/reference_resources.js#L665-L812
[N8]: https://github.com/CreatorAris/nephele-aura/blob/a3e1efc139d30e207c2fbd008235d4481770201b/app/%28tabs%29/index.tsx#L208-L213
[N9]: https://github.com/CreatorAris/nephele-aura/blob/a3e1efc139d30e207c2fbd008235d4481770201b/app/%28tabs%29/index.tsx#L711-L719
[N10]: https://nephele.arisfusion.com/zh/docs/moodboard
[N11]: https://github.com/CreatorAris/nephele-wisp/blob/18d6cdf55180bebf7973b056ee53c3bc8072cc13/extension/background/handlers/reference_board.js#L108-L134
[B1]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/fileio/schema.py
[B2]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/fileio/sql.py#L247-L313
[B3]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/items.py#L244-L256
[B4]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/items.py#L185-L298
[B5]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/config/settings.py#L111-L114
[B6]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/fileio/sql.py#L183-L228
[B7]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/view.py#L378-L388
[B8]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/fileio/export.py#L109-L260
