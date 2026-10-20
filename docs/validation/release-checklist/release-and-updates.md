# 发布与自动更新（#70）

## 一次性准备（只有仓库所有者能做）

更新签名私钥只放在 GitHub 仓库的 Actions secret 里，**不进仓库、不发给别人**；公钥写进 `src-tauri/tauri.conf.json`。没有这两样时，发布工作流照常构建安装包，但跳过更新包签名与 `latest.json`（日志里有警告），已安装的 Kinshoko 也不会检查更新（设置里显示“此构建未启用自动更新”）。

1. 在自己的电脑上生成密钥对（设一个密码；私钥文件放在仓库目录之外，并另外备份——丢了私钥或密码，已安装的用户就再也收不到更新）：
   ```
   npx tauri signer generate -w %USERPROFILE%\.tauri\kinshoko-updater.key
   ```
2. 仓库 **Settings → Secrets and variables → Actions → New repository secret**，建两个 secret：
   - `TAURI_SIGNING_PRIVATE_KEY`：`kinshoko-updater.key` 文件的全部内容；
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：第 1 步设的密码。
3. 把 `kinshoko-updater.key.pub` 的内容（一行 base64）填进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，提交。公钥可以公开。
4. **更新地址必须能匿名访问。** `plugins.updater.endpoints` 指向 `https://github.com/Yukk1No/kinshoko/releases/latest/download/latest.json`；仓库目前是私有的，画师的 Kinshoko 访问它会得到 404，自动更新不会工作。二选一：把仓库改为公开；或另建一个公开的发布仓库，把 endpoints 改成那个仓库，并让发布工作流把 Release 建到那里（需要一个对该仓库有写权限的令牌作为 secret，替换 `gh release create` 用的 `github.token`）。

工作流的配对检查：有私钥没公钥时失败；推送标签时有公钥没私钥也失败（否则这个版本的更新包没有签名，已安装的用户收不到）。

## 每次发布

- [ ] 在 GitHub 的分支菜单里从 `integration/v1` 新建分支 `release/v<版本号>`（例如 `release/v1.0.0-beta.1`；正式版也从 `integration/v1` 建）。`prepare-release` 会在这个分支上改好 `Cargo.toml`、`Cargo.lock`、`package.json`、`package-lock.json` 的版本号，运行摘要里给出开 PR 的链接。（不用 Actions 页面的“Run workflow”：它要求工作流文件在默认分支 `main` 上。）
- [ ] 打开这个 PR、等 CI 通过后合并。测试版、候选版合并后 `tag-release` 就打标签 `v1.0.0-beta.1` 并调用 `release`；正式版要再随 PR #71 合进 `main`，`tag-release` 才在 `main` 上打标签。带 `-` 的版本建成预发布；预发布不算 `releases/latest`，正式版通道收不到，测试版通道经 `channel-beta` 收到（见下面 `beta-channel` 一条）。
- [ ] `release` 工作流检查标签与版本一致，构建、静默安装检查（`kinshoko.exe` 与 `DirectML.dll` 都在安装目录），建一个**草稿** Release，附件为安装包、`.sig` 与 `latest.json`，说明文字是 [安装说明](../../install.md) 加自动生成的变更列表。
- [ ] 下载草稿里的安装包，在**没有开发环境的 Windows**（例如新建的 Windows 沙盒或干净的虚拟机）上以普通用户安装：不出现管理员确认；SmartScreen 提示按 [安装说明](../../install.md) 点“仍要运行”后能装上；启动后能建库、导入、看图；打标能用（DirectML 或 CPU）。
- [ ] 在 GitHub 上发布这个草稿 Release（发布前 updater 看不到它）。
- [ ] 发布后 Actions 里的 `beta-channel` 工作流成功，`channel-beta` Release 的 `latest.json` 是这个版本（测试版、候选版、正式版都会更新它；比通道里旧的版本只记一条说明、不更新）。`channel-beta` 必须保持预发布、不能标成 latest，不要手动删除。工作流失败时日志第一条错误说明原因（例如这个版本没有 `latest.json`），修好后把这个 Release 转回草稿再发布，工作流会重跑。打标签的提交里必须有 `.github/workflows/beta-channel.yml`（`release` 事件用标签提交里的工作流文件，不看默认分支）。
- [ ] 装着上一版的电脑上打开 Kinshoko（发布的是测试版或候选版时，“设置 → 更新 → 更新通道”要选测试版；装着测试版的电脑默认就是测试版通道）：主窗口底部提示新版本；“安装并重启”后自动退出、静默安装、重新打开，主窗口底部状态栏的版本号是新版本；钉图位置保留。
- [ ] “设置 → 更新 → 检查更新”显示“已是最新版本”。

## 数据文件夹（#145，ADR-0009）

- [ ] 从旧版本（数据在 `%APPDATA%\dev.kinshoko` 与 `%LOCALAPPDATA%\dev.kinshoko`）升级后第一次启动：设置、资料库、钉图、截图历史、参考组和已下载的模型都在；安装目录下出现 `data\`（含 `settings.json`、`device.json`、`tag-catalog.sqlite`、`models\`、`logs\`、`webview\`）；两个旧目录里各有一份 `MOVED.txt`，写明新位置；看图背景与墙的滚动位置也还在（WebView2 数据随之改名到 `data\webview`）。再启动一次不会重复迁移
- [ ] 覆盖安装同一版本或新版本、自动更新后：`data\` 原样保留
- [ ] 交互式卸载：弹出“同时删除设置与打标模型？（资料库不受影响）”，默认“否”；选“否”后 `data\` 保留，选“是”后 `data\` 与安装目录都被删除；资料库文件夹都不受影响
- [ ] 静默卸载 `uninstall.exe /S`：`data\` 保留
- [ ] 手动运行新版安装包、在“已安装”页选“先卸载再安装”：旧版卸载程序会问同一句，选默认的“否”后 `data\` 保留

## 诊断（#70）

- [ ] “设置 → 诊断 → 显示诊断信息”列出系统、处理器、内存、显卡、WebView2 版本、每台显示器的型号、分辨率、缩放、SDR／自动色彩管理／HDR 与配置文件名称；全文没有用户名、路径与文件名。在开着 HDR 或自动色彩管理的显示器上各看一次模式是否正确。
- [ ] 打开“强制 sRGB”：设置里提示重启生效，当前窗口颜色不变；从托盘退出再启动后，任务管理器“详细信息”里 `msedgewebview2.exe` 的命令行带 `--force-color-profile=srgb`，诊断信息里“强制 sRGB：已开启”。在广色域显示器上，广色域测试图在强制 sRGB 下变得更艳（不再按显示器配置文件转换）。关掉后再重启恢复。
- [ ] 使用日志默认关闭；打开后导入、查找、截图、钉图、贴边隐藏各做一次，“导出使用日志…”得到的文件每行只有时间、动作名与数量；关闭后不再增加；“清除使用日志”后导出为空。
