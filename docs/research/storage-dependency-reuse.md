# 首个正式功能的 SQLite 依赖复用

2026-10-03（Asia/Shanghai）。对应 [核查竞品技术栈与首个功能的可复用依赖](https://github.com/Yukk1No/kinshoko/issues/12)。仅核对一手文档、固定源码与包元数据，未构建、安装或做故障实测。

**建议 Rust 侧采用 `rusqlite 0.40.2`，启用 `bundled, backup`，迁移复用 `rusqlite_migration 2.6.0`。** 后者依赖 `rusqlite ^0.40.0`，最低 Rust 1.95，相容已核验；Windows 构建仍待验收。[rusqlite 发布][rv]、[迁移包版本][mv]、[依赖约束][md]

首切片覆盖建库、打开、复制本地静态原文件、保存元数据、缩略图／原图浏览及关闭重开。沿用[固定存储提案](https://github.com/Yukk1No/kinshoko/blob/90bef426bf0899f0341c3f407574826aa0ad794c/docs/discovery/data-storage-model.md)：每库一个 SQLite 保存库身份、版本和整理信息，原文件位置相对库根，不增设另一份可修改的 `library.json`。SHA-256 标识原字节，不代表全部元数据或全局记录；跨库稳定引用后续实现。来源刷新只改来源拥有的字段，后续人工整理须独立保留。

| 固定候选 | 已核验能力 | 本切片取舍（推断） |
|---|---|---|
| rusqlite 0.40.2（2026-08-08） | 同步事务、Online Backup 封装、bundled SQLite。[API][rc]、[构建][rr] | 选；领域命令可直接控制文件与 DB 的顺序。 |
| SQLx 0.9.0（2026-05-21） | SQLite 用后台线程；自带嵌入式迁移。[发布][sv]、[连接][sc]、[迁移][sm] | 可用，但当前单库顺序任务不需要其 async 查询层；不引入池。 |
| 官方 Tauri SQL 2.5.0（2026-09-26） | 基于 SQLx ^0.8，支持 Rust 迁移和 JS `load/select/execute`。[包][pv]、[文档][pd] | 暂不选；前端 SQL 可绕过导入、身份和人工数据保护规则。 |

竞品取舍沿用[图库](library-storage-practices.md)、[Eagle](eagle-storage-practices.md)、[参考板](reference-board-practices.md)的固定证据：Hydrus 先落文件再写 DB。[源码][h] Eagle 分开原文件与缩略图路径。[API][e] BeeRef 保存会重新编码图片。[保存源码][b] 因此复用 SQLite 的事务／快照能力，原图保持原始字节，缩略图作为可重建缓存。

每个打开的库由一个专用线程独占 `Connection`，有界队列接收领域命令；前端收结果，不发送 SQL。`Connection` 为 `Send`、非 `Sync`。[连接 API][rc] 文件处理在后台执行；关闭先停止新任务，完成或留存待处理项，再释放连接。连接启用外键，忙等待设上限；不增加 ORM、池或通用仓储。

`bundled` 编译并静态链接内置 SQLite，用户无须配置 SQLite DLL；构建机仍需 MSVC C++ 工具。[构建说明][rr]、[Windows 前提][wp] 提交 Cargo.lock 固定传递依赖并记录实际 SQLite 版本，在无开发工具的 Windows 环境验收安装包。

迁移只追加已发布 SQL，`user_version` 由迁移包管理；它提供原子迁移并拒绝超前 schema。[迁移 API][ma] 打开已有库不带 CREATE，先只读查库身份、版本与完整性，再决定写入。升级先取得 DB 快照；失败、损坏或不兼容时保留原库，不自动重建／降级。

**文件发布与 SQL 提交分别恢复。** 库内同卷暂存→复制、同步落盘并关闭文件→校验完整 SHA-256／长度，去重候选逐字节比对→提交最小 pending 项（操作 ID、预期内容、暂存／目标相对路径、待写元数据）→拒绝覆盖地发布文件→SQL 事务提交图片／来源并清除 pending。重命名即使原子可见，也不与 SQL 组成共同事务；普通 `rename` 可覆盖目标、不能跨卷，需在实现中约束。[Rust 文件接口][rn]

重开时按 pending 对账：目标匹配则补提交；仅暂存匹配则继续；缺失或错字节则保留任务并报错。已提交项缺图保留元数据并报缺失。无任务账目的孤立文件先报告，核验归属后才清理。成功项重试不得另建同图或覆盖人工字段；数据库提交前不报告成功，始终不删除来源。只用这张小状态表恢复。

SQLite Backup API 只保证 DB 快照，外部原图仍需应用协调。[官方说明][sb] 本地备份建议暂停导入／清理，取得快照后复制其引用的原文件并校验，最后标记完整。**首个长期使用版本必须通过本地恢复；首切片不交付全部备份／远端能力。schema 与备份包格式仍是提案，未冻结；持续同步协议另行设计，本轮不新增 ADR。**

实施前仍须通过以下门槛（均未执行）：

- **迁移**：初始化 v1；有已发布旧版后，带数据样本升级并核对字段、外键与 `integrity_check`。中途 SQL 失败须回滚；超前版本／损坏库拒绝打开且原数据保留，升级前快照可恢复。
- **导入中断**：复制中、pending 提交后、发布后、最终 DB 提交前后强制退出；另注入磁盘满、拒绝访问、文件占用和来源变化。重开／重试应无重复成功记录、无错字节 ready 项，能指出剩余任务，来源逐字节不变。
- **恢复**：备份后恢复到新目录，以全文件字节比较、SHA-256／长度和元数据对照核验全部原图；删除缓存仍能重建浏览。缺图、损坏或不支持版本不能标记完整，已有库不得被覆盖。

[rv]: https://docs.rs/crate/rusqlite/0.40.2
[mv]: https://crates.io/api/v1/crates/rusqlite_migration/2.6.0
[md]: https://crates.io/api/v1/crates/rusqlite_migration/2.6.0/dependencies
[rc]: https://docs.rs/rusqlite/0.40.2/rusqlite/struct.Connection.html
[rr]: https://github.com/rusqlite/rusqlite/blob/v0.40.2/README.md
[sv]: https://docs.rs/crate/sqlx/0.9.0
[sc]: https://docs.rs/sqlx/0.9.0/sqlx/struct.SqliteConnection.html
[sm]: https://docs.rs/sqlx/0.9.0/sqlx/macro.migrate.html
[pv]: https://docs.rs/crate/tauri-plugin-sql/2.5.0
[pd]: https://v2.tauri.app/plugin/sql/
[h]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/client/importing/ClientImportFiles.py
[e]: https://developer.eagle.cool/plugin-api/api/item
[b]: https://github.com/rbreu/beeref/blob/f53abad9c8ec34c12130464586d3750eea7279b7/beeref/items.py#L185-L298
[wp]: https://v2.tauri.app/start/prerequisites/#windows
[ma]: https://docs.rs/rusqlite_migration/2.6.0/rusqlite_migration/struct.Migrations.html
[rn]: https://doc.rust-lang.org/std/fs/fn.rename.html
[sb]: https://sqlite.org/backup.html
