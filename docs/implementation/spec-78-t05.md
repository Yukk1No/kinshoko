# #78 T05：全局标签分组

本单对应 #84、故事 28／29。用户整理一次分组后，在各资料库共用。分组展开为可见成员的任一条件，图片的标签与原文件保持原样。

这是独立增量。复用前置代码基线 `536cc43c1933e44fc33836f8a439de8cdb0da018`，没有改写 #42／PR #71 或旧验收状态。分支 `codex/spec-78-t05` 从集成 `16c8760e016be0a8e1bcc9d97ac362b8feab9c7d` 开始，实际工作树为已结束 T04 的 managed tree `spec78-t02-tag-identity/kinshoko`，未清理旧 ignored 证据。已合入 T08 `748e4c62e6db8e2b4e7b92db4f92597c182bf976`。

## 核心行为与持久状态

[`tag_catalog/groups.rs`](../../crates/kinshoko-core/src/tag_catalog/groups.rs) 承担分组创建、改名、删除、分组排序、成员添加／移除／排序。分组与成员持久保存在应用的统一标签目录。成员使用统一身份；查找时通过已有 Workspace 的统一身份转换，分别转换为各来源的库内 ID。

显式成员分组保留用户顺序。命名空间分组动态列出该类可见身份，继续区分同名作品、作者等身份。没有给图片增加分组属性，没有通过分组操作写入图片标签。

统一目录 schema 升至 4：`catalog_group`、`catalog_group_member`、`catalog_group_migration`。本单不新增内容库 schema。旧库中的原始分组名称、命名空间、库内成员顺序和来源库身份保存在独立来源记录。每个 `(library_id, group_id)` 迁移一次；同名来源生成不同应用分组，打开顺序不会覆盖成员。迁移不回写旧库。

删除分组后，迁移记录仍在，`target=None`。重新打开未更改的旧库不会恢复已删除分组。来源记录和用户当前分组定义分别保存，用户之后改名或修改成员不会改写来源历史。

[`TagCatalog::group_definitions()` 和 `group_migrations()`](../../crates/kinshoko-core/src/tag_catalog/groups.rs) 是后续 T13 程序设置备份的公开核心接口。前者返回当前有序分组、完整统一成员和原始来源；后者包括指向存活分组的迁移记录及删除记忆。T13 应同时保存／替换两者及必要的统一身份，避免设置恢复后旧库重新迁移。它们属于程序设置，不能加入资料库内容备份。本单未实现 T13 的导入／原子替换动作。

普通 UI 只接收 `CatalogGroupView`。来源仅含库名、旧分组名及身份，不含原始隐藏成员 ID、文字或数量。`CatalogGroupDefinition` 和全量迁移历史不暴露为普通 IPC。

## 安全视角与组合回归

全局分组通过 Workspace 的所有已知来源判断可见性。同字节图片只要任一来源为 Adult，安全模式就隐藏其专用成员；未命中查询、范围外、已知离线来源也参与否决。读取使用独立只读 provider，不改活动库的安全模式。

安全模式下的合法改名、排序、添加／移除可见成员，保留所有未返回的隐藏成员。不能用过滤后的成员列表替换完整成员。显式提交隐藏 ID 的非法编辑整次事务失败，不留下先处理项目的部分写入。

根代理额外用公开接口复现 `A Adult / B Unknown` 同文件时，普通名称设置仍暴露 B 专用标签的问题。本单接入原 RED 后修复：`TagCatalog::inspect_libraries` 复用同应用目录的 Workspace 持久事实；名称设置、迁移向导、分组管理使用同一可见规则。可见性只过滤返回投影，不删除原始目录。未使用的合法定义仍可管理；同一标签还有可见图片使用时保留，计数只包含可见非回收站图片。搜索候选继续使用实际有效图片，管理分组另保留合法零使用定义。

## 正式界面与原型

直接读取并适配固定认可 `bd8aea44c4a311571ee3c07382cb7755f87f3153` 的 [`TagGroupBar.tsx`](../../prototype/reference-browser/src/components/TagGroupBar.tsx)：保留标签弹层、计数、点击／Ctrl 点击／右键条件手势，增加明确的“任一成员”整组查找动作。认可基线未改动。

正式 [`TagGroupsPane`](../../src/library/TagGroupsPane.tsx) 同时用于侧栏与程序设置。显示旧库来源、明确的改名／删除／排序动作、成员顺序和工作区标签选择。设置中的全局分组不要求活动库，空分组也能改名。模式或工作区代次变化清空旧视图，拒绝迟到响应；同一视角内刷新期间保留已显示结果。

三个新 IPC `shared_tag_groups`、`create_shared_tag_group`、`edit_shared_tag_group` 在前端、handler 与 `src-tauri/build.rs` inline commands 一致登记，沿用 `library:default`。Tauri 只适配核心动作、安全模式代次与工作区状态。

## 独立 RED → GREEN

应用 TDD 技能。核心检查调用公开动作，创建真实 SQLite 与真 PNG；没有以私表断言替代业务验收。

| 场景 | 实现前失败 | 通过证据 |
| --- | --- | --- |
| A 的旧组在 B 活动时可用、重开与图片标签不变 | 返回 0 组，预期 1 | `core-red.log` → `core-seven-green.log` |
| 无活动库创建与持久化 | 公开动作返回 UnknownGroup | `create-red.log` → `create-green.log` |
| 分组与成员管理／排序 | 公开动作返回 UnknownGroup | `organize-red.log` → `organize-green.log` |
| 两库 OR、缺失映射、同名迁移、删除记忆、动态命名空间／当前名称 | 在前述公开行为 RED 后增量实现 | `catalog-visibility-green.log` |
| 安全模式合法编辑保留隐藏成员、非法批量编辑原子失败 | 沿用首次全局组 RED；另补正向往返 | `core-safe-edit-roundtrip.log`、最终核心检查 |
| 正式设置无活动库、来源／排序、迟到视图与认可弹层 OR | 新组件或操作缺失 | `frontend-red.log` → `frontend-regression-03.log` |
| 名称设置与分组的全来源 Adult 规则／未使用定义 | 封印专用词泄露；未使用成员返回 UnknownTag | `catalog-visibility-red.log` → `catalog-visibility-green.log` |

新增公开核心检查 9 项：`catalog_groups.rs` 7 项，`catalog_visibility.rs` 2 项。新增前端分组检查 4 项，现有分组检查 11 项适配全局 IPC。完整前端首轮 247／248，标签对应 fixture 捕获的旧控件未及时更新；补等待实际可点击状态并重新查询当前行，完整复跑 31 文件 248 项通过。原始失败日志保留，未把首轮说成通过。

## 实际检查与来源

2026-10-09，Windows 11。Cargo 只使用本工作树 `target`，并发 2。完整前端 248 项、TypeScript 和 Vite 已通过。Rust 完整工作区在组合可见性修复前通过；修复后的完整检查正在完成。Clippy 首轮两处测试的多余 clone 告警已修复，保留原日志。

## 原生正式程序

原生验收脚本 [`shared-tag-groups.mjs`](../../e2e/shared-tag-groups.mjs) 使用冻结 v16 schema、真 PNG、两份旧库、独立 identifier／配置目录／WebView profile／端口。脚本将记录产品提交、逐文件来源、dist、二进制哈希、driver、真实公开 IPC 与 UI 操作结果；正常重启通过已观察的托盘“退出”菜单回调完成。

状态：尚未执行。构建后补本轮实际证据，不能继承 T04 或 T09 的原生通过结果。

## 未验证

开发者实际安装环境和真实旧库的人工验收未执行。自动原生操作不等于人工体验认可。Windows 10 没有设备／虚拟机，用户已接受保留未验证状态。实际系统 DPI、多显示器、笔输入和广色域硬件不在本单已执行范围。T13 程序设置恢复由后续工单实现。
