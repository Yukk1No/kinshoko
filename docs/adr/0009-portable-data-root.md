# 程序自己的数据都放在 exe 旁边的 data 文件夹，装在不可写的位置时直接报错

#115 验收时维护者反馈：程序自己的数据分散在 `%APPDATA%\dev.kinshoko`（设置、资料库登记、标签目录、工作区、钉图、截图历史、参考组、备份计划）和 `%LOCALAPPDATA%\dev.kinshoko`（打标模型、使用日志、WebView2 数据）两处，程序本体却在 `%LOCALAPPDATA%\Kinshoko`，画师找不到、备份和清理也不直观（[#145](https://github.com/Yukk1No/kinshoko/issues/145)）。决定：应用只有一个数据根目录 `<exe 所在目录>\data\`，所有这些内容都在它下面；资料库（画师选的文件夹）不受影响。数据根目录的解析只在应用壳启动时做一次（`kinshoko_core::data_dirs`），各模块不再自己调用 Tauri 的 `app_*_dir`；测试用的 `KINSHOKO_DATA_DIR` 覆盖全部数据，包括 `settings.json`。

旧版本的数据在首次启动时迁移：`data\` 为空、旧位置有数据时，逐项改名搬进 `data\` 旁边的暂存目录，全部到齐后一次改名为 `data\`，旧目录里留 `MOVED.txt`。旧数据在另一个卷上时才复制，复制完整后再删旧的。中途失败时把搬过的放回原处，本次运行继续用旧位置并在诊断信息里写明，下次启动重试；连放回原处也失败时不回到旧位置运行（那里缺了东西），报错退出。进程在迁移中途被结束时，暂存目录里的日志让下次启动先把条目放回原处。开发构建与设了 `KINSHOKO_DATA_DIR` 时不迁移；`data` 旁边的 `data.lock` 保证第二次启动不会和正在运行的实例同时迁移。

`data\` 不可写时（例如以后被装进 `Program Files`）启动时弹出说明位置和原因的错误并退出，不悄悄改写到别处。卸载时：自动更新、静默和被动卸载一律保留 `data\`；交互式卸载问“同时删除设置与打标模型？”，默认“否”。

## Considered Options

- **合并到 `%LOCALAPPDATA%\Kinshoko` 这样的系统目录**：装到哪里都可写，也是 Windows 的惯例；但数据和程序仍在两处，卸载、搬家、备份时画师要分别找。维护者选了便携式布局。
- **留在 `%APPDATA%`（Roaming）**：漫游配置会把 1～3 GB 的打标模型带进域账户同步，所以模型本来就放在 Local；设置留在 Roaming 只会让数据继续分两处，而本应用没有跨设备漫游设置的需求。
- **`data\` 不可写时自动退回 `%LOCALAPPDATA%`**：能启动，但画师的数据会悄悄出现在另一个地方，和这次决定要解决的问题相反。等真的要支持装进 `Program Files`（按机器安装）时再重开。
- **迁移失败时启动失败**：不会出现“新旧各一半”，但画师当天就用不了软件；回到旧位置运行同样不丢数据。

## Consequences

- 当前按用户安装到 `%LOCALAPPDATA%\Kinshoko`，安装目录可写。改成按机器安装需要先重开本决定。
- 卸载程序不能递归删除 `$INSTDIR`；升级 Tauri 时要确认 NSIS 模板仍只逐个删除自己装的文件（`installer-hooks.nsh` 的 `NSIS_HOOK_POSTUNINSTALL`）。
- 每个窗口都要用同一个 WebView2 用户数据目录 `data\webview`，否则后建的窗口会因为环境冲突建不出来（`SharedWebview`）。
- 开发时 `target\debug\data\` 就是开发版的数据根目录。
