# #78 T08：各资料库独立目录与查找范围

本单承接 #87，对应 #78 故事 6、7、8。实现起点为集成提交 `71e635dabe38ff4e7ef55695088addd8bfa9881b`。没有修改 #42、PR #71 或其历史验收记录。

## 实现

- `Workspace::directories` 返回每个已登记资料库的完整目录树。资料库与文件夹分别保留身份。同名目录不按名称合并。同名资料库显示最短可区分的路径末段，完整路径保留在提示中；只在驱动器不同的情况保留驱动器差异。路径可换行。
- `BrowseScope::Folder` 保持直接层级语义。新增 `FolderTree` 表示包含全部子目录，`Unassigned` 表示本库未归类图片。两种目录查询共用 Rust 范围解释器，先按每份来源完整匹配，再按文件字节身份聚合。
- 正式侧栏一次显示全部资料库根。默认包含子文件夹，并提供明确开关。所选开关在后续目录选择中保留。目录数字随开关显示直接层级数量或去重后代数量。同图同时归属父目录或多个子目录时只计一次。图片归属与计数在 Rust 处理，`Sidebar` 中的 `FolderNode.count` 继续表示直接层级。
- 文件夹整理继续使用带明确资料库身份的既有动作。当前活动库可新建、改名、移动目录；其他库本单保持只读。未激活库写入由 T09 承接。浏览不切换活动写入资料库。
- 断连库显示原因并禁用旧目录控件。失效文件夹或移除的资料库保留当前范围身份，不静默改为全部资料库。迟到目录响应不覆盖新代次；读取中修订变化会自动重读。
- 全部目录计数、后代计数、未归类计数和查询结果沿用 T07 全来源成人内容否决。范围之外、未匹配或断连的已知成人来源仍可隐藏同一文件。
- Tauri `workspace_directories` 同时登记在 handler 与 `build.rs`，沿用主窗口 `library:default` capability。核心动作不依赖 Tauri。

## 原型来源

直接参考 `prototype/spec78-alignment/folder-workspace.html` 的 `renderTree`、`folderRows`、`contained`、`folderRecords`、`fw-descendants` 与路径提示。正式界面适配其按库分根、完整层级、未归类、后代开关与后代计数；数据来自 Rust 真实 provider。

继续复用 T01 恢复的认可 `prototype/reference-browser` 浏览布局。两份固定原型保持原文。原型只作体验对照。

## 目录修订与兼容

追加迁移 `0087_folder_revision.sql`。新建、改名、重排、移动或删除文件夹时增加列表修订号，让旧目录状态和分页失效。未修改既有迁移。

该迁移升级内容库格式。旧程序不能直接打开升级后的资料库。回退需要升级前的备份，或使用兼容的新程序。只读旧格式 provider 继续显示需要升级的明确原因，不暗中升级。

## 自动检查

初次完整检查源码为 `a2db11ef221ad454511c916732acaa5153e36634`，树为 `d31e4c336a02b162f522245e7ca43c5733cbaada`：

- 完整 Rust 工作区：578 passed，0 failed，7 ignored。6 个 ignored 为既有父测试执行的故障注入子进程入口；1 个为既有大型性能测试。本单未重跑该性能门槛。
- 严格 `cargo clippy --workspace --all-targets -j2 -- -D warnings`、`cargo fmt` 通过。
- 完整前端：29 文件、235 项通过。TypeScript 与 Vite 构建通过。

后代计数修正在 `3c9380b`：7 项本单公开行为测试通过；既有工作区 7 项通过。测试使用真实 SQLite 与图片文件，验证同名森林、直接/含后代范围、多归属、原图路径和字节不变、失效范围、结构修订、移动后旧游标拒绝，以及断连重启后的全来源安全规则。重复归属和安全过滤有独立计数测试。严格 core/app clippy、界面与 App 63 项、TypeScript、Vite 通过。

路径显示修正在 `4b50e1777e5de007df1afeb466b7293d6ebdfa3c`：目录界面 5 项、TypeScript、Vite 通过。新增公开 UI 检查覆盖共同长前缀与仅驱动器不同的同名库。

最后合入 `16c8760` 的源码为 `f6f6be9b34b3b82f481e8eb4ef924521e6534ca9`。冲突仅在 `src/ipc.ts` 的相邻类型导入和追加函数。已保留旧名向导与目录森林全部接口。App 同时保留向导提示与目录森林。定向补验：

- 工作区 7 项、目录 7 项、旧名迁移 7 项通过。故障注入子进程另执行 1 项；其入口在顶层列表标记 ignored。
- App、目录森林、旧名向导、设置面板共 84 项通过。TypeScript、Vite、`cargo fmt --check` 通过。
- 合并后的原生适配器 `cargo check -p kinshoko --locked -j2` 通过。

收尾提交 `b7d9bb7709962000c2da4fd0ee5644fc20446a12` 将相同路径函数原样移到 `src/library/library-path.ts`，导出 `libraryPathHint(root, roots)` 给 T09 来源面板复用。森林 5 项与 TypeScript 通过。另将 Rust 字段说明移到结构体文档，并重新生成绑定，导出检查 1 项通过；该文档调整不改变接口或行为。

以上完整检查和后续定向检查按各自源码记录，没有把完整检查数量当作最后源码的重跑结果。每次检查使用本树独立 target，Cargo jobs=2。

RED 原始证据保存在 [evidence/spec78-t08](evidence/spec78-t08)：目录新建未改变修订、含子目录接口缺失、断连范围被当作成功空查询、正式森林请求缺失、目录过期未自动重读、后代数字缺失及长路径不能直观看出区别。

## 正式原生验证

环境：Windows 11 专业版，版本 `10.0.26300`，64 位。WebView 观测 DPR `1.1041666269302368`，CSS viewport `1281 × 801`。该观测不替代实际系统 DPI 或多屏验收。

两次试件都使用 debug + `tauri/custom-protocol`，嵌入正式资源、使用正式 IPC，identifier 为 `dev.kinshoko.spec78t08test`；driver 4558/4559；应用数据与 WebView 数据独立；跳过系统自启。没有生产签名或公开发布。

| 验证 | 产品源码 | 二进制 SHA256 | 结果 |
| --- | --- | --- | --- |
| 故事 6、7、8 完整目录业务 | `c1ba9504c9f0481b792313d78fcd69bbe9288be7` | `113B6F37B51FACCB004E14EEF369310E6136BA3D6BA7DE1C7C3C6496A75E7B98` | 21 项通过 |
| 路径显示定向补验 | `4b50e1777e5de007df1afeb466b7293d6ebdfa3c` | `910E84BCDF4642517EB523D1F690B98F63FF83CD6F438C16719E7F04D5C6568A` | 2 项通过 |

[完整业务结果](evidence/spec78-t08/native-business-result.json) 与 [路径补验结果](evidence/spec78-t08/native-paths-result.json) 分别记录真实产品提交、树、试件哈希、脚本提交与脚本哈希。脚本为 `e2e/workspace-folders.mjs`。两个实际通过的 exe 与真实资料库数据均保留在 ignored `work/e2e`，交给根任务归档。

完整业务步骤：通过正式 IPC 建立两个同名库、同名父子目录、多归属图片和同字节跨库图片；通过正式控件切换库范围、直接/含子目录范围与未归类范围；真实鼠标与键盘新建、双击改名；公开动作移动子树并拒绝旧游标；核对原图路径与哈希不变；将其他来源标为 Adult 后检查图片墙与计数；通过正式控件取消登记，再重启断连库，检查失效范围与禁用目录。

首轮脚本在 WebDriver `clear` 触发失焦后找不到名称框。原始失败证据保留。改用真实指针双击与 Ctrl+A 覆盖后，完整业务通过。路径补验最初截图捕到启动刷新瞬间，随后等待森林状态稳定再取证；稳定截图已目视核对。[最终目录截图](evidence/spec78-t08/directory-forest-final.png)、[含后代范围](evidence/spec78-t08/descendant-scope.png)、[全来源安全否决](evidence/spec78-t08/folder-safety-veto.png)、[失效范围](evidence/spec78-t08/removed-scope.png)、[断连库](evidence/spec78-t08/disconnected-root.png) 分别保留对应来源的画面。

最后原生清理核对：本单 app、driver、WebView 无残留，4558/4559 无监听。实际清理方式及系统信息记录在 [清理清单](evidence/spec78-t08/native-cleanup.json)。桌面排期已明确交还。后续合入 T04 只执行上述定向自动检查，未将这两份原生证据改标为合并后源码。

## 未验证

开发者主观体验、Windows 10、多显示器/实际系统 DPI、触笔与广色域硬件检查未验证。负责人已确认目前没有 Windows 10 验证设备，保留未验证状态。debug 试件不代表 release 性能或颜色硬件验收。

#78 全增量组合验收与真实公开签名自动更新由 T20/T21 分别承接。本单不替代这些验收。
