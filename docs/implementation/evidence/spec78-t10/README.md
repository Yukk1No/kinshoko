# T10 独立证据

[copy-manifest.json](copy-manifest.json) 给出 ignored 原件的真实来源、字节数与逐字节副本 SHA256。测试资料库、WebView profile 和三个冻结 exe 原件继续保留在实现工作树；根任务另作归档。旧脚本从对应 Git blob 复原 Windows checkout 换行后核对执行 SHA，具体方法见 [harness-reconstruction.json](harness-reconstruction.json)，没有假称旧工作区脚本仍在。

## 自动检查

- [完整 workspace 统计](checks.json)：70 个顶层 Cargo 套件，645 passed、0 failed、9 ignored。故障子进程不重复计数。
- [合 T06 的受影响核心统计](after-t06-checks.json)：57 passed、0 failed、1 ignored。该入口由公开父测试实际启动。
- [最终完整前端](automatic-checks/after-t06-full-ui.txt)：34 文件、266 项通过。
- [最终严格 Clippy](automatic-checks/after-t06-clippy.txt)、[TypeScript](automatic-checks/after-t06-typecheck.txt)、[格式](automatic-checks/after-t06-fmt.txt)、[最终构建](automatic-checks/native-build-final.txt)。
- [复制刷新 RED](automatic-checks/copy-refresh-red.txt) → [GREEN](automatic-checks/copy-refresh-green.txt)；[过早完成文案 RED](automatic-checks/premature-publication-red.txt) → [GREEN](automatic-checks/premature-publication-green.txt)。
- [其余原始日志](automatic-checks/) 保留真实收尾、同步句柄、注销撤权、重试可见目标的 RED→GREEN。最早五次 RED 只有工具输出，本目录不声称包含其原始完整日志。旧 UI 夹具未选择新目标的 19 项失败、默认并发中 TagIdentityPanel 一项超时、误写 Cargo 测试目标、首次 npm 参数转发构建错误及后续通过均保留。

## 原生各轮边界

| 原件 | 产品 | 实际范围 |
| --- | --- | --- |
| [首轮](native-first/result.json) | a2f2c3e | 原脚本记录20项通过。19项实际归属/分项/取消/Eagle/包/截图字节/复制结果保持；一项读取隐藏DOM，不能作为可见性通过。 |
| [补验一](native-followup-first-failed/result.json) | 56bedde | 9项通过后，脚本点击已活动浏览区收起侧栏，再点隐藏范围按钮失败。截图同时暴露过早完成文案。 |
| [补验二](native-followup-second-fixture-failed/result.json) | 54694d4，含T06 | 前10项通过，实际展开的窗口显示 current C、下一保存 A、原任务 B（27/2000），没有过早完成文案。复制窗口实际关闭；脚本等待普通无备注来源的 note.sources，夹具断言错误而超时。 |
| [仅复制补验](native-copy-passed/result.json) | 同一个54694d4 exe | 给B真实来源备注，C已有独立人工备注。8项通过，其中4项为普通导入重复前置；复制保留来源和C备注，同文件不重复，确认窗口刷新后保持关闭。 |

首轮外部删除目录前采样进度为8/1200，最终33项完成、1167项失败；没有改放A或C。注销/运行中切库及实际取消另有公开核心检查。首轮原位置截图没有展开导入窗口，复制结束截图仍有确认窗口；两张原图保留，没有改写。

全部16张实际截图均经本地查看，路径和SHA见 [screenshots.json](screenshots.json)。最终复制关闭图仍显示来源面板“正在读取该来源…”，只据截图确认弹层状态。来源和目标人工备注以实际公开IPC断言为证，不称图中已可见备注。T20继续检查来源加载后的最终组合界面。

[首轮完整smoke](smoke-first-result.json) 与 [最终同exe完整smoke](smoke-final-result.json) 各5项通过，含正式目标确认、真实导入、比例及强制重启恢复。[原smoke脚本](smoke-harness.mjs) 的SHA与两轮结果一致。

## 源码与释放

- [首轮构建后清单](build-source.json)、[56补验构建后清单](followup-build-source.json)、[最终546构建后清单](final-build-source.json)。这些清单都是构建结束后采集，只有首轮构建时整个工作树clean；后续如实记录未跟踪T10文档/证据，tracked产品clean。
- [最终copy-only清单](copy-followup-source.json) 区分冻结产品546与纯harness提交ac18510及执行SHA，不以当前HEAD冒充产品源码。
- [实际Windows环境](windows-environment.json)、[验收后487个源码文件与10个dist文件](source-dist-after-native.json)。这是验收后采集，不称为构建前清单。
- [最终释放](native-final-release.json)：三个精确own exe、全部六轮data/profile的app/driver/WebView进程及4586/4587为空。独立identifier的Roaming/Local目录不存在；只移除核对为空的Local临时目录。[首轮释放](native-release.json)与[首扫描](native-release-first-scan.json)保留。首扫描误匹配扫描器自身，最终扫描按程序名称限定。

清理使用WebDriver会话关闭及精确进程结束，不声明正常托盘退出。Windows10未验证。没有关闭T20/T21或将这些记录替代完整规格的组合验收。
