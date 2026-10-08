# 更新阶段（#78 / #97）

默认 `src-tauri/tauri.conf.json` 的 `plugins.updater.releaseStage` 为 `private`。未配置阶段的兼容配置也按私有阶段处理。私有阶段使用同一产品的新版 NSIS 安装包手动更新，程序不请求 `latest.json`，检查和安装命令都返回手动更新说明。

只有仓库所有者确认原仓库 `Yukk1No/kinshoko` 已公开、`latest.json` 可匿名读取，且已准备好配对的生产更新签名配置后，才把同一配置的 `releaseStage` 改为 `public`。这项配置是发布者的明确阶段声明，不自动改变 GitHub 仓库可见性。

公开阶段同时要求：

- `plugins.updater.pubkey` 非空。下载后仍由现有 Tauri updater 校验 Minisign 签名，错误签名拒绝安装。
- `plugins.updater.endpoints` 只有原仓库入口 `https://github.com/Yukk1No/kinshoko/releases/latest/download/latest.json`。不接受另一个发布仓库或其他后备入口。
- 阶段值恰为 `public`。未知阶段拒绝自动检查和安装，并显示原因。

每次检查与安装都重新应用相同核心策略；不能靠先前可用的更新对象绕过阶段条件。主窗口只在状态为 `unchecked` 时自动检查。缺公钥或入口时设置页说明原因；手动安装包更新仍可用。

公开更新继续复用 `.github/workflows/release.yml`、`src-tauri/tauri.updater.conf.json`、原仓库 Releases 的签名包与 `latest.json`、原下载进度和错误提示。安装前继续调用 `desktop::on_exit` 保存钉图；本单没有新增发布仓库或更新下载器。

历史 #70 发布清单保持原文；其中“另建公开发布仓库”的备选项不适用于 #78。当前决定为私有阶段手动更新，达到质量要求后公开原仓库。本单不公开仓库、不发布 Release、不合并 PR、不生成或配置生产私钥。真实公开签名更新由 #99 单独验证，本地配置与受控响应不能代替它。

私有升级证据使用独立产品名、程序文件名、identifier、安装目录和资料目录。测试包可以采用 debug 构建验证功能升级；这不表示 release 性能、颜色质量、Windows 10 或真实公开自动更新通过。
