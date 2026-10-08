# #78 T11：可携带的标签定义与参考组包

关联：[独立规格 #78](https://github.com/Yukk1No/kinshoko/issues/78) 故事 37；[工单 #90](https://github.com/Yukk1No/kinshoko/issues/90)。这是本次增量实现记录。没有改写 #42、PR #71 或此前验收记录。

## 实现与边界

普通资料库保存 `PortableTagBinding`。每条记录有本地标签 ID、稳定全局 ID、命名空间、默认名称、别名及外部词表与值。`PortableTagDefinition` 没有显示名称偏好字段。显示偏好继续保存在程序统一标签目录中。

首次写入本地标签时，在同一资料库事务内保存非权威的稳定种子定义。后续目录登记可以依据明确外部对应选择已有全局身份。两个库不再因不同的新种子而丢失原有外部对应。明确发布后的记录标为权威绑定；复制库在新应用中还原该稳定身份。纠正或拆分不会再由来源旧外部词撤销。同名或别名重合不会合并已经声明的稳定身份。复用已经存在的种子身份时保留本机的定义和偏好。

`TagCatalog::publish_library_definitions` 将程序中的纯默认定义和实际映射写回所选资料库。`Library::publish_tag_definitions` 在一个资料库事务中验证并提交完整批次。程序目录事务与资料库事务分别提交。它们不是跨存储原子事务。程序中的纠正、名称和别名已经保存后，如果发布失败，界面会说明资料库尚未更新，并提供每库的“保存标签定义到资料库”重试入口。

包导入完成时也发布目标程序的当前纯定义。目标程序删掉的别名不会在复制库后恢复。封印依赖保留完整绑定；已知权威身份使用本机当前纯定义，不因发布而增加安全界面中的隐藏映射。

普通标签整理和明确来源的标签整理完成后，会经 T09 的 `DeviceLibraries::write` 缓存写池发布定义。没有另建写池，不切换 current 或 lastOpened。T10 使用固定任务拥有的目标句柄，在导入、收藏和跨库复制完成路径复用发布接口。本单不改 T10 的任务归属。

默认表更新、别名修改及名称规则修改先保存在程序中。下一次实际标签写入或每库明确保存操作携带最新所需定义。只读登记和目录检查不暗中迁移或发布。离线、只读或写入失败时，程序选择保留，恢复可写后可重试。可携带的原始定义与安全模式下的界面筛选分开；导出及依赖发布不会因为界面隐藏而删除已有原始绑定。

追加资料库迁移 `0090_portable_tags.sql`。没有改写既有迁移。旧程序不能读取升级后的新格式库。回退须使用升级前备份或兼容的新程序。尚未升级的旧格式只读 provider 继续给出明确不可用原因；不会因只读登记发生升级。

参考组包版本升为 2。每个使用的标签都带显式来源本地 ID 和完整可携带定义。导入用声明的稳定身份解析到目标本地 ID。版本 2 缺少身份、同一 ID 的定义互相冲突、命名空间冲突或原图 SHA 不符时，先拒绝，再写入内容。旧版本 1 仍走原有兼容导入。

正式包导出读取当前程序的纯定义，不要求来源 provider 可写。包中原图不重编码。成员裁剪、翻转、旋转、缩放、布局及来源信息保持既有往返规则。内容导入不替换目标程序已有偏好，不恢复目标删掉的别名，不修改全局分组和个人近似。中途存储失败时，已进库内容按原契约保留；重试会按原图及稳定身份复用，不声称整个包跨存储原子提交。

共用公开接口 `CatalogInspection::apply_content_definitions(library_id, &mut ImageSnapshot)` 给包导出和 T10 跨库复制使用。调用方使用原始完整目录快照，不使用已筛选的 UI 工作区。界面继续使用认可原型 `prototype/reference-browser` 的设置 fieldset、表格和明确按钮；新增发布动作复用正式 `TagIdentityPanel`，原型未改动。

## 红灯与公开检查

公开检查使用真实 Library、TagCatalog、ReferenceGroups、SQLite、原图和 ZIP。原始日志留在本工作树的 ignored `work/`，失败记录保留。

- `t11-red-first-library.txt` → `t11-green-first-library.txt`：普通首次标签写入后直接复制库，空应用保留全局身份。
- `t11-red-split-library.txt` → `t11-green-split-library.txt`：纠正、拆分与定义发布后复制库；默认、别名随库，程序偏好不随库。
- `t11-red-package.txt` → `t11-green-package.txt`：包导入保留稳定身份，同名目标保持独立。
- `t11-red-live-catalog-export.txt` → `t11-green-live-catalog-export.txt`：导出使用当前程序定义。
- `t11-red-missing-definition.txt` → `t11-green-definition-validation.txt`：新包缺定义时拒绝，旧版本 1 仍可导入。
- `t11-red-target-identity-conflict.txt` → `t11-green-target-identity-conflict.txt`：目标程序已有同 ID、不同命名空间时，导入前拒绝。
- `t11-red-reused-seed.txt` → `t11-green-reused-seed.txt`：同一稳定种子进入第二个本地标签时复用身份，保留本机偏好。
- `t11-red-import-current-definitions.txt` → `t11-green-import-current-definitions.txt`：包导入完成后立即复制目标库，携带本机当前纯定义。
- `t11-red-hidden-dependency-publication.txt` → `t11-green-hidden-dependency-publication.txt`：全部使用被封印时，原始依赖仍更新已有权威身份的纯定义与外部词表。
- `t11-red-publish-ui.txt` → `t11-green-publish-ui.txt`：界面发布失败说明与重试。该渲染测试为补充验证，不替代原生调用。

故障测试实际在子进程中向资料库发布事务注入 SQLITE_FULL 和退出码 99。失败后旧批次完整保留，重试完整提交。ignored 的 `publication_subprocess` 是父公开测试主动启动的入口，不是未执行的验收。`t11-green-publication-atomicity.txt` 和后续完整日志保留真实结果。

初次完整 core 检查 `t11-core-final-pass1.txt` 为 605 passed、0 failed、9 ignored。应用 5 项、tagger 4 项另行通过。此前完整检查暴露的历史 Eagle 迁移夹具错误留在 `t11-core-all.txt`；夹具补上新迁移表和触发器的回退，13 项 Eagle 再导入回归通过。新增种子复用与共用适配器之后，11 项便携行为、6 项包往返、11 项统一目录、8 项名称公开检查通过。严格 workspace/all-targets Clippy 通过。

完整前端为 31 文件、250 项通过。TypeScript 与 Vite 构建通过。原始日志为 `t11-ui-all.txt`、`t11-typecheck.txt`、`t11-vite-build.txt`。新增命令 `publish_tag_definitions` 同时登记在 handler 和 `build.rs` inline commands，沿用主窗口 `library:default`。

## 正式原生验收

待最终组合源码与二进制固定后填入精确结果。本段目前不表示通过。

## 未验证与后续

Windows 10 未验证。用户已明确接受保留此状态。本机为 Windows 11。

T12 后续复用便携定义模块处理资料库及程序设置备份。T10 的后台任务归属和目标路径由其工单独立验收。全流程组合、规模性能门槛和发行外部门槛仍属于对应后续工单；本单没有继承它们的通过状态。
