# 备份、恢复与同步事实核查

核查日期：2026-10-01。仅核对官方文档；未选定项目工具或协议，未配置用户存储。

## 能力区别

同步工具通常会传播修改与删除。Syncthing 的官方 [FAQ](https://docs.syncthing.net/users/faq.html) 明确说明这一行为，并建议另用工具保护数据。其 [文件版本保留](https://docs.syncthing.net/users/versioning.html) 默认关闭，保存接收其他设备修改或删除时的旧文件，不保存本设备自己修改前的版本。

因此，“其他设备有副本”和“误删或损坏前的状态可恢复”应分别定义和验收。

## 用户自选存储具有现成技术依据

- restic 支持本地目录、用户自己的 SFTP/REST 服务与 S3 兼容存储等目标，并提供按快照恢复与历史保留策略。官方文档：[存储目标](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)、[恢复](https://restic.readthedocs.io/en/stable/050_restore.html)、[保留与清理](https://restic.readthedocs.io/en/stable/060_forget.html)。
- rclone 的 `sync` 使目标匹配来源，包括删除；`copy` 不删除目标已有文件，`--backup-dir` 等参数另行处理历史留存。官方文档：[sync](https://rclone.org/commands/rclone_sync/)、[bisync](https://rclone.org/bisync/)。

这些工具证明可使用现有传输、快照与恢复能力连接用户提供的存储；尚未决定由 Kinshoko 直接实现、调用工具还是提供扩展接入。本文也没有承诺任何第三方服务的免费容量。
