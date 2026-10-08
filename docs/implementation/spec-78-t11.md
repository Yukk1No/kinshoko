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

公开检查使用真实 Library、TagCatalog、ReferenceGroups、SQLite、原图和 ZIP。原始日志留在本工作树的 ignored `work/`，失败记录保留。逐字节副本、来源与 SHA256 已收纳到 [独立 T11 证据目录](evidence/spec78-t11/README.md)。

- `t11-red-first-library.txt` → `t11-green-first-library.txt`：普通首次标签写入后直接复制库，空应用保留全局身份。
- `t11-red-split-library.txt` → `t11-green-split-library.txt`：纠正、拆分与定义发布后复制库；默认、别名随库，程序偏好不随库。
- `t11-red-package.txt` → `t11-green-package.txt`：包导入保留稳定身份，同名目标保持独立。
- `t11-red-live-catalog-export.txt` → `t11-green-live-catalog-export.txt`：导出使用当前程序定义。
- `t11-red-missing-definition.txt` → `t11-green-definition-validation.txt`：新包缺定义时拒绝，旧版本 1 仍可导入。
- `t11-red-target-identity-conflict.txt` → `t11-green-target-identity-conflict.txt`：目标程序已有同 ID、不同命名空间时，导入前拒绝。
- `t11-red-reused-seed.txt` → `t11-green-reused-seed.txt`：同一稳定种子进入第二个本地标签时复用身份，保留本机偏好。
- `t11-red-missing-local-mapping.txt` → `t11-green-local-mapping.txt`：新版包缺来源本地映射时，在写入前拒绝。
- `t11-red-import-current-definitions.txt` → `t11-green-import-current-definitions.txt`：包导入完成后立即复制目标库，携带本机当前纯定义。
- `t11-red-hidden-dependency-publication.txt` → `t11-green-hidden-dependency-publication.txt`：全部使用被封印时，原始依赖仍更新已有权威身份的纯定义与外部词表。
- `t11-red-publish-ui.txt` → `t11-green-publish-ui.txt`：界面发布失败说明与重试。该渲染测试为补充验证，不替代原生调用。

故障测试实际在子进程中向资料库发布事务注入 SQLITE_FULL 和退出码 99。失败后旧批次完整保留，重试完整提交。ignored 的 `publication_subprocess` 是父公开测试主动启动的入口，不是未执行的验收。`t11-green-publication-atomicity.txt` 和后续完整日志保留真实结果。

初次完整 core 检查 `t11-core-final-pass1.txt` 为 605 passed、0 failed、9 ignored。应用 5 项、tagger 4 项另行通过。此前完整检查暴露的历史 Eagle 迁移夹具错误留在 `t11-core-all.txt`；夹具补上新迁移表和触发器的回退，13 项 Eagle 再导入回归通过。新增种子复用与共用适配器之后，12 项便携行为、6 项包往返、11 项统一目录、8 项名称公开检查通过。严格 workspace/all-targets Clippy 通过。

完整前端为 31 文件、250 项通过。TypeScript 与 Vite 构建通过。原始日志为 `t11-ui-all.txt`、`t11-typecheck.txt`、`t11-vite-build.txt`。新增命令 `publish_tag_definitions` 同时登记在 handler 和 `build.rs` inline commands，沿用主窗口 `library:default`。

组合检查基于 `fd1b62c5a654d10ac81781524494e162dfe5711f`。该提交到下述原生构建提交的产品 Git blobs 没有变化。最终 workspace 为 **633 passed、0 failed、9 ignored**，71 个顶层套件。子进程自己的结果不重复计入。最终前端为 **32 文件、255 项通过**。严格 workspace/all-targets Clippy、TypeScript 和 Vite 构建通过。对应 `t11-t05-combined-*` 原始日志与 [计算明细](evidence/spec78-t11/checks.json) 保留。

## 正式原生验收

Windows 11 正式桌面程序通过 **26 项**便携流程断言。开发者逐张检查了 8 张实际 WebDriver 截图。固定产品源码为 `a99fd7683e5c00b896c99aaa49129ebfe2eefdf5`，tree 为 `411ed9a68e23f968fe05b820579f8d1de743f5d3`。二进制为本工作树 `target/debug/kinshoko.exe`，SHA256 为 `6DE689C8BB36E8FA0F1D7D037766D3D595CCBDB0A8E280C2177A80B9B495ED58`。构建使用 `tauri/custom-protocol`、独立 identifier `dev.kinshoko.spec78t11test` 及本树 target。包含 T05 的全来源安全筛选和 T09 的缓存写池。

通过轮的验收脚本提交为 `a07e073d63e905e05644fb7ef0925466ac4e7cfc`，脚本 SHA256 为 `c5264f13bc3365b543b8c882773f089e5cd39671cef3d331551504afe23029fb`。夹具创建通过公开 IPC；纠正、拆分、名称偏好、别名、定义发布、参考组保存、包导出与导入使用实际渲染控件。文件选择器沿用既有测试结果队列。后端、SQLite、ZIP、原图及原生钉图都实际执行。

通过范围包括：两库同名身份独立，明确合并及拆分，显示偏好与定义分离，真实 SQLITE_FULL 发布失败的可见说明及重试，原始目录断开后空应用登记复制库，全新应用及已有偏好环境导入包，原图 SHA、备注、命名空间和外部词表完整，成员裁剪、翻转、旋转、缩放与布局往返，来源记录、真实钉图可打开，同名目标保持独立，全局分组保持，重复导入复用本地映射、保留名称偏好且不恢复已删除别名。导入完成后立即复制目标库，空应用仍还原目标当前纯定义。

首轮在拆分等待超时。实际 DOM 仍显示旧身份；脚本在目录异步读取时过早操作控件。补充启用状态及读取完成等待后，同一个产品二进制通过全部流程。首轮截图、DOM、结果和日志仍保留于 [首轮原件](evidence/spec78-t11/native-first-failed/result.json)。通过轮原件见 [26 项结果](evidence/spec78-t11/native-passed/result.json)。没有通过改写失败原件制造通过状态。

同一个固定二进制另完成根任务修正后的完整 smoke，**5 项通过**，包含真实建库、导入、瀑布流比例、强制重启后的库身份和图片墙恢复。该脚本 SHA256 为 `49FA759E3F6356C5600EF3EFA3609CFC05CCE080247BF60E4CA056E361DD4E23`，见 [实际结果](evidence/spec78-t11/ci-smoke-result.json)。该 CI 修复由根任务独立记录。

本轮端口 4568/4569。结束后精确 exe、驱动、该轮 WebView 与监听端口均为空，见 [释放记录](evidence/spec78-t11/native-release.json)。清理使用 WebDriver 会话关闭和精确进程结束。这里没有宣称完成正常托盘退出验收。

[源码和 dist 逐文件清单](evidence/spec78-t11/source-dist-after-native.json) 在 `2026-10-08T18:05:07Z` 原生验收后采集，包含 516 个源码输入和 10 个 dist 文件。它不是构建前清单。当前 dist 的 JS/CSS 名称与实际 Vite 日志、原生 DOM 中资源地址一致。已合入根最新 `423bd64519917c40fba7407b721789d6684dd4a6`，合并提交为 `a9e813df4c0986e0e9e1ee513917fdddb7daaa10`；固定构建提交到合并提交的产品 Git blobs 无变化。后续只收纳证据和更新本单记录。

## 未验证与后续

Windows 10 未验证。用户已明确接受保留此状态。本机为 Windows 11。

T12 后续复用便携定义模块处理资料库内容备份。T13 独立处理程序设置备份。T10 的后台任务归属和目标路径由其工单独立验收。全流程组合、规模性能门槛和发行外部门槛仍属于对应后续工单；本单没有继承它们的通过状态。
