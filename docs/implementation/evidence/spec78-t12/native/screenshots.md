# 第四轮截图的实际范围

开发者在原生完成并释放桌面后，逐张查看以下 7 张原始 PNG。原件 SHA 和来源在 [native-original-copies.json](../native-original-copies.json)。没有裁剪、重绘或修改截图。下列描述只记录截图中实际可见的内容。

| 原始截图 | 可见内容 | 不由本图单独证明 |
| --- | --- | --- |
| [01-source-group](runs/content-backup-t12-00dfc61-fourth/01-source-group.png) | 主窗口参考组“内容备份跨库组”、3 个成员、两个来源库；图片墙 3 图。 | 原生钉图窗口、完整裁剪/布局数值、备份内容。 |
| [02-backup-preview](runs/content-backup-t12-00dfc61-fourth/02-backup-preview.png) | 资料库备份标题、内容/设置边界、备份位置和按钮。 | 视口下的完整预览数值、范围和成功反馈。 |
| [03-fresh-restore-result](runs/content-backup-t12-00dfc61-fourth/03-fresh-restore-result.png) | 空白程序当前范围、备份位置、所选快照列表和恢复入口。 | 视口下的恢复成功文字；独立 ID、原图哈希或设置隔离。 |
| [04-open-restored-group](runs/content-backup-t12-00dfc61-fourth/04-open-restored-group.png) | 恢复库名称、恢复组 3 成员、来源“可用”、局部 50×40 提示和成员入口。 | 全部原生钉图窗口、完整布局数值。 |
| [05-existing-settings](runs/content-backup-t12-00dfc61-fourth/05-existing-settings.png) | 已恢复库的备份范围、约 0.7 MB 预览、原图新写入 0 张。 | 名称偏好、别名删除、全局组、个人规则保持。 |
| [06-recovered-library](runs/content-backup-t12-00dfc61-fourth/06-recovered-library.png) | 首库中断重试后主窗口、当前库/组范围和约 1.4 MB 预览。 | 中断时的发布数量、启动回退或完整成功文字。 |
| [06-recovered-group](runs/content-backup-t12-00dfc61-fourth/06-recovered-group.png) | 首组中断重试后主窗口、当前库/组范围和约 2.1 MB 预览。 | 中断时的发布数量、启动回退或完整成功文字。 |

预览、恢复成功、来源 ID、当前设置保持和两处回退结论来自 [实际 result.json](runs/content-backup-t12-00dfc61-fourth/result.json) 的 57 项断言，以及脚本直接读取的正式 DOM、公开动作和只读 SQLite。钉图结论另来自实际公开打开动作和持久 pin 回读。

原生窗口已经关闭。未为补图重跑已通过的 57 项。T20 后续负责最终组合中完整可见的预览和成功反馈截图。本记录不把原图内容截取管线与 WebDriver 主窗口截图混同。
