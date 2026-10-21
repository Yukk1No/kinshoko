<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo-kit/lockups/horizontal-night.svg">
    <img alt="Kinshoko" src="design/logo-kit/lockups/horizontal-day.svg" width="320">
  </picture>
</p>

<p align="center">
  给二次元画师的本地参考图库与桌面钉图工具。
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

Kinshoko 帮画师收集、整理、查找画画时要用的参考图，再把参考钉在绘画软件上层。它想一次替代两样工具：Eagle 这类图库的“存和找”，以及 Snipaste 的钉图。

> [!NOTE]
> Kinshoko 目前是**测试版**（`1.0.0-beta.1`），只支持 Windows 10/11 x64。在你的电脑上验证过备份能恢复之前，请自己另外保留一份原图。

## 功能

- **迁入 Eagle 资料库。** 自动找到电脑上的 Eagle 1.8.x 与 4.x 资料库，连同标签、文件夹层级、来源链接和备注一起迁入。之后重新迁入时，只更新 Eagle 提供的信息，你在 Kinshoko 里做的整理都保留。
- **从哪里都能收图。** 导入文件或整个文件夹、拖进窗口、从剪贴板收进，或把截图收藏进资料库。完全相同的图只存一份，每次的来源都留着。
- **自动标签与内容分级。** 每张图由本地运行的打标模型（[PixAI Tagger v1.0](https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8)，可走显卡 DirectML 或 CPU）给出标签建议和分级，人工修正永远优先。
- **按想画的东西找图。** 用标签、文字和中文别名查找。近似查找会把相近的标签一起找，比如“蓝瞳”也找“水色瞳”，并且明确列出展开了哪些，你可以改回精确查找。
- **钉在屏幕上。** 把整图、局部或屏幕上任意区域钉在绘画软件上层。钉图可以翻转、旋转、调透明度、锁定，可以贴边隐藏并把焦点交还绘画软件。关掉主窗口，钉图也还在。
- **参考组。** 把局部和整图存成一组，下次直接复用，可以跨资料库。
- **安全模式。** 默认开启。浏览和查找中不出现成人内容，参考组和钉图里原位遮蔽。
- **多个资料库。** 可以新建、登记、切换和搬移资料库。Kinshoko 从不改动你的原图。
- **本地备份与恢复验证。** 备份到另一块盘，并检查原图、整理信息和参考组都能完整恢复。

以图搜图、语义搜索、按颜色找图、多设备同步等后续方向记录在 [roadmap](docs/discovery/roadmap.md) 中。

## 安装

1. 从 [Releases](https://github.com/Yukk1No/kinshoko/releases) 下载 `Kinshoko_<版本>_x64-setup.exe`。
2. 双击运行。安装包只装到当前用户，不需要管理员权限。电脑上没有 Microsoft Edge WebView2 运行时时会联网安装（Windows 11 自带）。
3. 安装包暂时没有代码签名，Windows SmartScreen 可能显示“Windows 已保护你的电脑”。确认是从本仓库 Releases 页面下载的之后，点“更多信息 → 仍要运行”。

Kinshoko 从 GitHub Releases 检查更新，安装前校验更新包的签名。卸载不会删除你的资料库。

打标模型不随安装包附带。第一次自动打标时，Kinshoko 会先告诉你下载大小，再从 Hugging Face 下载。

## 隐私

Kinshoko 在你自己的电脑上离线工作，不需要账号，也没有遥测。联网只有两处：向 GitHub 检查更新，以及首次下载打标模型。

“设置 → 诊断”生成的诊断信息只有系统、显卡、WebView2 与显示器信息，不含文件名、路径和图片，可以直接贴进问题反馈。“记录使用日志”默认关闭，日志只留在本机，由你决定是否导出。

## 反馈

现阶段最有用的贡献是画师的使用反馈。请用模板[提交 issue](https://github.com/Yukk1No/kinshoko/issues/new/choose)：

- **交互反馈**：用着别扭、找不到，或者打断绘画的地方。
- **标签识别错误**：自动标签或内容分级明显不对。
- **兼容性结果**：钉图在你的数位板、显示器和绘画软件组合上的表现。

中文或英文都可以。安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 参与开发

开发环境、目录结构和提交改动的流程见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。领域术语见 [GLOSSARY.md](GLOSSARY.md)，重要决定记录在 [docs/adr/](docs/adr/)。

## 许可证

Kinshoko 是自由软件，按 [GNU 通用公共许可证第 3 版或更新版本](LICENSE)（GPL-3.0-or-later）发布。

按 GPLv3 第 7 条附加一项许可：Kinshoko 可以与 ONNX Runtime 及 Microsoft DirectML 链接并一起分发（打标子进程随应用附带这两个库），见 [LICENSE-EXCEPTION](LICENSE-EXCEPTION)。

随仓库分发的第三方内容保留各自的许可证：

- [`public/fonts/`](public/fonts/) 里的 Inter 与思源黑体（Source Han Sans SC）字体按 SIL Open Font License 1.1 授权。
- [`.claude/skills/`](.claude/skills/) 里的 agent skills 按 MIT 许可证授权，见 [`LICENSE-mattpocock-skills`](.claude/skills/LICENSE-mattpocock-skills)。
- 打标模型不随 Kinshoko 分发，在运行时下载，适用各自模型卡上写明的许可证。
