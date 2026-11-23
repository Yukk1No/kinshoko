# 界面用语对照表（#358）

英文界面里反复出现的词各定一个说法，全篇照用。左列是界面上实际写的中文（不是 `GLOSSARY.md` 的开发用语），
右列是英文；一格里有几种写法时用 ` / ` 隔开，都算对，靠前的是首选。这张表只放在资源文件旁边，不进 GLOSSARY。

`src/i18n/terms.test.ts` 按这张表检查：中文里有左列的词，对应的英文就要有右列的某一种写法（不分大小写）。
左列的词是更长的词的一部分时（例如“参考组包”里的“参考组”），按更长的那一行查。
实在放不下的个别文案写进测试里的例外，并写明原因。

加词：在表里加一行，跑 `npm run check -- src/i18n/terms.test.ts`，按报出来的地方改译文或补例外。

| 中文 | English | 说明 |
| --- | --- | --- |
| 参考组包 | reference group package / group package | 地方不够时省掉 reference |
| 参考组 | reference group | |
| 参考图 | reference image | |
| 图库 | library / libraries | |
| 图片墙 | image wall | |
| 钉图 | pin | 名词与动词都用 pin，不写 pinned image |
| 截图 | screenshot | 名词与动作都用 screenshot，不用 capture |
| 桌面 | desktop | 不写 desk |
| 安全模式 | safe mode | 标题、开关写 Safe mode |
| 回收站 | trash | 作名称时写 Trash |
| 自动标签 | auto-tag | 进程、模型写 auto-tagging |
| 相近标签 | similar tag | 不带相近标签写 leave out similar tags |
| 显示名 | display name / names | 设置分页标题地方小，写 Names |
| 详情 | details | |
| 查看器 | viewer | |
| 订阅 | subscription / subscribe / subscribing / subscribed | |
| 画师 | artist | |
| 作品 | work | |
| 收藏 | bookmark / collect | pixiv 的收藏写 bookmark；收藏进图库写 collect |
| 备份 | backup / back up / backed up / backing up / backs up | |
| 运行日志 | run log | |
| 文件夹 | folder | |
