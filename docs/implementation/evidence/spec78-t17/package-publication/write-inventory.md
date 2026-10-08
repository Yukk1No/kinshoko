# 正常分级和来源发布路径

实现基线为合入 b856 的 3bd4b3f。此表盘点真正的 SQL 写点，避免按文件重复加锁。

| 写点 | 正常入口 | 最终提交边界 |
| --- | --- | --- |
| `rating::set_manual` 更新 `image.rating_manual` | SourceEditor `workspace_edit_source` 的 SetRating/RevertRating；兼容 library edit | App source_actions / edit 已持共享 visibility gate |
| `rating::replace_source_rating` 替换 `rating_fact` 来源层 | 真实自动打标 scheduler | 推理和解释后，共享 TaggingConfig publication gate→writer；等待后复核暂停/停止 |
| `package::commit` 替换 `rating_fact` 包来源层 | 参考组包 `import_from_package`；`copy_from/copy_snapshot_from` | Library 配置的共享 package gate，在 commit_record caller→writer；只有 Some(PackageFacts) 取锁 |
| permanent_delete 删除 `rating_fact` 及 image | workspace 永久来源删除；兼容永久删除 | App 最终 gate→设备/catalog/资料库/参考组资源 |
| 资料库备份恢复复制数据库，包括旧分级 | `Library::restore_at` / Backup restore | 只写不存在或空目录，生成新 Library 身份，不覆盖现有已登记来源；IO 在外，register_restored 在 gate 内发布新提供方 |
| 新建、登记、切换、初次恢复、取消登记 | DeviceLibraries 对应动作 | App transition→gate→设备；旧 scheduler detach/drop/join 在 gate 外 |
| 普通文件导入 | ImportTask 的 Origin.package=None | 新图插入或来源合并；不写分级、不删除已有可见图；不取 package gate |
| Eagle 导入/重导 | ImportTask 的 Origin.package=None，eagle::commit | 来源层标签、备注、链接、绑定和文件夹更新；不写分级，不因 Eagle 删除而删除已有可见图；同批新图可清初始 trash 标记 |

所有评级 SQL 写入已搜索 rating_fact/rating_manual；schema migrations 不是运行中的结果发布入口。
应用的目标句柄在 fixed_library / forward_events 统一配置，for_destination 共用 inner。只读提供方禁止写入，默认无配置保留 core 独立使用。

## 锁序和等待

PackageFacts 的许可必须在调用线程、writer.run 之前取得。自动打标已持 gate 等待 writer；若 package 的 writer job 再取 gate，会形成反向等待。
包和跨库复制是同步动作，不进入 DeviceLibraries.tasks。普通/Eagle worker 不取得 package gate；unregister 的现有 settle/join 因此不增加 gate 循环。
注销可能仍等待既有普通/Eagle 当前导入项结束；这里不宣称注销总体耗时有上限。撤销的写权限已先设置，后续实际事务核对 write_revoked。调度线程的 detach/join 不持 gate。
App 包入口仅取得 CatalogInspection，释放 catalog 后处理所有文件。每张图提交取 gate→writer；导入后定义发布取 gate→catalog→writer，最后保存新参考组。不存在 catalog→gate。

## 外部证明与限制

新增两条公开测试使用真实 SQLite 资料库、真实原图与真实参考组包。目标先存在相同字节且没有人工分级；源快照为 Explicit。RED 中实际完成且持锁期间 effective=Some(Explicit)。GREEN 中持锁期间仍未评级，释放后为 Explicit。
另一个公开测试丢弃 PackageImport 后确认内容仍在、新组文件未保存；重试 finish 后只保存一个新组。旧包损坏与 catalog 命名空间冲突的预检测试继续通过。
这些是纯 Rust 公开行为证明。未对包/复制执行 native 竞态探针。其他进程直接改 SQLite 或原图不参与此进程许可，只能按最终读取时观察。
