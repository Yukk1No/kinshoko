<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo-kit/lockups/horizontal-night.svg">
    <img alt="Kinshoko" src="design/logo-kit/lockups/horizontal-day.svg" width="320">
  </picture>
</p>

<p align="center">
  画画时的参考图，收好、找到、钉上。
</p>

<p align="center">
  <a href="https://github.com/Yukk1No/kinshoko/releases"><img alt="最新预发布版" src="https://img.shields.io/github/v/release/Yukk1No/kinshoko?include_prereleases&label=pre-release"></a>
  <a href="LICENSE"><img alt="许可证：GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue"></a>
  <img alt="平台：Windows 10/11 x64" src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

---

Kinshoko 是给画师用的参考图工具。平时看到好图就收进来，它会自动打上标签；画画时一搜就能找到，再把它钉在绘画软件旁边，边看边画。

> [!NOTE]
> Kinshoko 目前是**测试版**，只支持 Windows 10/11 x64。在你的电脑上验证过备份能恢复之前，请自己另外保留一份原图。

## 功能

- **钉在画布旁边。** 把整张图、图里的一块，或屏幕上任何地方钉在绘画软件上层。可以翻转、旋转、调淡、锁住防误触；暂时不用就推到屏幕边上，不挡画。关掉主窗口，钉图也还在。
- **随手收图。** 拖进来、粘贴、截图，或者一次导入整个文件夹。同一张图只存一份。
- **自动打标签。** 收进来的图会自动标上发色、服装、动作之类的标签，不用一张张手填；标错了随时改。
- **按想画的东西找。** 用中文就能搜。搜“蓝瞳”也会带上“水色瞳”这类相近的图，不想要时可以改回精确查找。
- **参考组。** 把一张画要用的几张参考存成一组，下次直接拿出来用。
- **安全模式。** 默认开启。成人向的图不会突然出现在屏幕上，直播或和别人一起看屏幕时也放心。
- **图都在你自己的电脑上。** 不用注册，不联网也能用，从不改动你的原图。可以备份到另一块盘，并检查能不能完整恢复。
- **分开放。** 工作用、私人用可以建成不同的资料库，随时切换。
- **从 Eagle 搬家。** 已有的 Eagle 图库可以连同标签和文件夹一起搬进来。

以图搜图、语义搜索、按颜色找图、多设备同步等后续方向记录在 [roadmap](docs/discovery/roadmap.md) 中。

## 安装

1. 从 [Releases](https://github.com/Yukk1No/kinshoko/releases) 下载 `Kinshoko_<版本>_x64-setup.exe`。
2. 双击运行。安装包只装到当前用户，不需要管理员权限。电脑上没有 Microsoft Edge WebView2 运行时时会联网安装（Windows 11 自带）。
3. 安装包暂时没有代码签名，Windows SmartScreen 可能显示“Windows 已保护你的电脑”。确认是从本仓库 Releases 页面下载的之后，点“更多信息 → 仍要运行”。

Kinshoko 从 GitHub Releases 检查更新，安装前校验更新包的签名。卸载不会删除你的资料库。

打标模型不随安装包附带。第一次自动打标时，Kinshoko 会先告诉你下载大小，再从 Hugging Face 下载。

## 隐私

Kinshoko 在你自己的电脑上离线工作，不需要账号，也没有遥测。只在以下情况联网：

- 从 GitHub Releases 检查并下载更新；
- 首次从 Hugging Face 下载打标模型；
- 电脑上没有 WebView2 运行时时，安装包从微软下载它。

“设置 → 诊断”生成的诊断信息只有系统、显卡、WebView2 与显示器信息，不含文件名、路径和图片，可以直接贴进问题反馈。“存成文件…”把它连同最近 7 天的运行日志打包成 zip；运行日志只记出错、警告和截图、钉图、打标、窗口的时间点与耗时，不记文件名、路径、标签文字和图片，只留在本机，最多 7 天、20 MB，测试版默认开启。

## 反馈

现阶段最有用的贡献是画师的使用反馈。请用模板[提交 issue](https://github.com/Yukk1No/kinshoko/issues/new/choose)：

- **交互反馈**：用着别扭、找不到，或者打断绘画的地方。
- **标签识别错误**：自动标签或内容分级明显不对。
- **兼容性结果**：钉图在你的数位板、显示器和绘画软件组合上的表现。

中文或英文都可以。安全问题请按 [SECURITY.md](.github/SECURITY.md) 报告。

## 参与开发

开发环境、目录结构和提交改动的流程见 [CONTRIBUTING.zh-CN.md](docs/CONTRIBUTING.zh-CN.md)。领域术语见 [GLOSSARY.md](GLOSSARY.md)，重要决定记录在 [docs/adr/](docs/adr/)。

## 许可证

Kinshoko 是自由软件，按 [GNU 通用公共许可证第 3 版或更新版本](LICENSE)（GPL-3.0-or-later）发布。

按 GPLv3 第 7 条附加一项许可：Kinshoko 可以与 ONNX Runtime 及 Microsoft DirectML 链接并一起分发（打标子进程随应用附带这两个库），见 [LICENSE-EXCEPTION](LICENSE-EXCEPTION)。

随仓库分发的第三方内容保留各自的许可证：

- [`public/fonts/`](public/fonts/) 里的 Inter 与思源黑体（Source Han Sans SC）字体按 SIL Open Font License 1.1 授权。
- [`src/ui/vendor/fluid/`](src/ui/vendor/fluid/) 里的 Fluid Functionalism 代码按 MIT 许可证授权，见其 [`LICENSE`](src/ui/vendor/fluid/LICENSE)。
- [`.claude/skills/`](.claude/skills/) 里的 agent skills 按 MIT 许可证授权，见 [`LICENSE-mattpocock-skills`](.claude/skills/LICENSE-mattpocock-skills)。
- 打标模型不随 Kinshoko 分发，在运行时下载，适用各自模型卡上写明的许可证。
