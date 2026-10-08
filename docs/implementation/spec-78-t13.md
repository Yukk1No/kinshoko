# #78 T13 / #92 程序设置备份

本单实现故事 33、34、36。前置 #42 / #71 的记录和完成状态不变。
精确实现起点：`b190770fc3d004c6f4fa101af1ff29cf8871b28f`。分支：`codex/spec-78-t13`。

## 实现

正式设置增加独立的“程序设置备份”入口。样式参考 `prototype/reference-browser/src/components/SettingsDialog.tsx` 的 fieldset/actions；读写走正式公开核心动作。文件扩展名为 `.kinshoko-settings`。

读取兼容备份后先显示替换范围，再由使用者执行替换。预览保留文件 SHA-256，文件变化后拒绝旧确认。名称偏好、应用词表、分组顺序及成员、个人近似判断与删除记录、程序配置默认替换；不导入设备库路径，不写原图或逐图整理。

包从完整原始目录读取，不使用安全模式过滤后的 UI 视图。携带统一标签定义、外部词条实际所有者、显式名称偏好、名称接管/旧名确认、别名删除记录、分组迁移空目标、近似规则迁移确认与空判断。显式偏好即使等于默认名称也保存。当前已有资料库的本地 ID→统一 ID 含义保留；缺席的当前名称偏好清除。

核心在配置发布前写持久撤销 journal。目录在单个 SQLite 事务内替换；壳设置经同目录临时文件写入、sync、rename。发布后删除 journal。发生错误时回退；异常退出后在 library 插件启动最早阶段、读取模型与壳设置之前恢复完整旧配置。恢复重试幂等。journal 使用完整本机旧状态；可携带的包不包含历史资料库根路径。

恢复刷新快捷键注册、模型选择、使用日志开关、安全模式、查找缓存与 workspace。目录请求代次在发布前后递增。参考截图来源、进行中的截图与逐张钉图显示授权失效。强制 sRGB 明确要求从托盘退出并重启。

查看器背景纳入程序设置。四种旧 localStorage 值 dark/mid/light/checker 兼容读取。直接备份而未打开查看器时也迁移。核心有值后旧缓存不能覆盖；无背景的旧设置包恢复为 Mid。首次读取失败不将旧缓存写回。按库滚动锚点保留本设备定位。

## 测试边界与结果

环境：Windows 11，开发者本机，真实 SQLite 与真实文件。核心公开动作验证持久行为。前端测试只补充交互合同。正式原生验收另行记录。Windows 10 未验证；负责人明确保留此状态。

`crates/kinshoko-core/tests/application_settings_backup.rs`：7 个公开集成测试、1 个被父测试显式执行的 ignored 子进程入口。3 个 journal/目录/壳设置发布点各执行 crash 与 error 共 6 个真实故障场景。crash 子进程退出 99；error 注入 SQLITE_FULL。另有实际 settings.json 目标变成目录的 rename 写入失败。验证空白恢复、完整依赖、默认同值显式偏好、替换不合并、别名 tombstone、旧组/规则删除后重连不复活、当前绑定和全部逐图资料/原图 hash、输入版本与预览指纹。

RED 证据在本树 ignored `work/t13/`。`name-red.txt`、`rules-red*.txt` 的早期版本和 `bindings-red.txt` 含测试夹具或编译修正，不能算产品 RED。有效产品 RED 为 `name-red-valid.txt`、`rules-red-product.txt`、`bindings-red-product.txt`、`write-failure-red.txt`、`crash-red.txt`、`external-owner-red.txt`。各项对应 GREEN 已保留，最终核心日志 `external-owner-green.txt`。

前端产品 RED `ui-red.txt` 说明正式入口缺失。交互 GREEN `ui-green.txt`。背景失败写回的产品 RED `viewer-background-red.txt`、GREEN `viewer-background-green.txt`。全量前端 `ui-final.txt` 共 263 项；TypeScript `types-final.txt` 成功。

全 Rust `cargo test --workspace` 日志 `rust-workspace.txt` 成功，包含 T13 的 6 个实际故障场景。严格 clippy 与原生固定源验证结果将在本单完成记录中补齐。未发生新增 unsafe。

## 原生验证

进行中，尚不能认定本单原生验收完成。脚本 `e2e/application-settings-backup.mjs` 使用正式备份/确认/替换控件，公共 IPC 准备与读取受控夹具。独立标识、固定可执行文件、源/dist/运行依赖清单、唯一端口与 KnownFolder 配置路径由 `work/t13/native-source.json` 记录。

脚本计划覆盖已配置目标、空白目标与旧库离线后重连、逐图资料/原图、实时快捷键与日志、同安全模式进行中的请求失效、正常托盘退出和强制 sRGB 下次启动、实际原生中断后 journal 启动恢复。托盘正常退出与故障退出分别留独立回执，不将强制结束算正常重启。
