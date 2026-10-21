<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo-kit/lockups/horizontal-night.svg">
    <img alt="Kinshoko" src="design/logo-kit/lockups/horizontal-day.svg" width="320">
  </picture>
</p>

<p align="center">
  A local reference library and desktop pinning tool for anime-style illustrators.
</p>

<p align="center">
  <a href="https://github.com/Yukk1No/kinshoko/releases"><img alt="Latest pre-release" src="https://img.shields.io/github/v/release/Yukk1No/kinshoko?include_prereleases&label=pre-release"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue"></a>
  <img alt="Platform: Windows 10/11 x64" src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

---

Kinshoko collects, organizes and finds the reference images an illustrator draws from, then pins them on top of the painting app. It aims to replace two tools at once: an image library such as Eagle for storing and finding, and Snipaste for pinning references to the screen.

> [!NOTE]
> Kinshoko is in **beta** (`1.0.0-beta.1`). It runs on Windows 10/11 x64 only, and the interface is in Simplified Chinese. Keep your own copy of your images until backups are verified on your machine.

## Features

- **Bring your Eagle library over.** Kinshoko finds Eagle 1.8.x and 4.x libraries on your computer and imports images with their tags, folder tree, source links and notes. Re-importing updates what Eagle provides and keeps what you organized in Kinshoko.
- **Collect from anywhere.** Import files or whole folders, drag and drop, paste from the clipboard, or save a screenshot into a library. Identical files are stored once and keep every source.
- **Automatic tags and content ratings.** Each image gets suggested tags and a rating from a local tagging model ([PixAI Tagger v1.0](https://huggingface.co/Mexes/pixai-tagger-v1.0-onnx-fp32-fp16-int8)), on the GPU through DirectML or on the CPU. Your manual corrections always win.
- **Find by what you want to draw.** Search by tags, text and Chinese aliases. Approximate search expands to related tags, such as blue eyes and aqua eyes, and shows you what it added so you can switch back to exact matching.
- **Pin to the screen.** Pin a whole image, a region or any part of the screen above your painting app. Pins can be flipped, rotated, faded and locked, and slide to the screen edge to hand focus back to the painting app. Pins stay up after you close the main window.
- **Reference groups.** Save regions and images as a reusable group, even across libraries.
- **Safe mode.** On by default. Adult content stays out of browsing and search, and is covered in place in groups and pins.
- **Multiple libraries.** Create, register, switch and move libraries. Kinshoko never modifies your original files.
- **Local backup with restore checks.** Back up to another drive and verify that originals, organization and groups come back intact.

Planned directions, such as image similarity search, semantic search, color search and multi-device sync, are listed in the [roadmap](docs/discovery/roadmap.md) (in Chinese).

## Install

1. Download `Kinshoko_<version>_x64-setup.exe` from [Releases](https://github.com/Yukk1No/kinshoko/releases).
2. Run it. The installer installs for the current user only and does not need administrator rights. It installs the Microsoft Edge WebView2 runtime if missing (Windows 11 already includes it).
3. Windows SmartScreen may say "Windows protected your PC" because the installer is not code-signed yet. If you downloaded it from this repository's Releases page, choose **More info → Run anyway**.

Kinshoko checks for updates from GitHub Releases and verifies each update's signature before installing it. Uninstalling never deletes your libraries.

The tagging model is not bundled. Kinshoko downloads it from Hugging Face the first time automatic tagging runs, and shows the download size first.

## Privacy

Kinshoko works offline on your own machine. There is no telemetry and no account. The only network requests are update checks to GitHub and the one-time model download.

The diagnostics in **设置 → 诊断** (Settings → Diagnostics) list only system, GPU, WebView2 and display information, never file names, paths or images, so you can paste them into an issue. The usage log (记录使用日志) is off by default, stays on your machine, and is exported only when you choose to.

## Feedback

Feedback from illustrators is the most useful contribution right now. [Open an issue](https://github.com/Yukk1No/kinshoko/issues/new/choose) using one of the templates:

- **UX feedback**: anything awkward, hard to find, or that interrupts your drawing.
- **Tag error**: an automatic tag or content rating that is clearly wrong.
- **Compatibility result**: how pinning behaves with your tablet, display and painting app.

Writing in Chinese or English is fine. To report a security issue, see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, project layout and how to propose changes. Domain terms are defined in [GLOSSARY.md](GLOSSARY.md), and the major decisions are recorded in [docs/adr/](docs/adr/).

## License

Kinshoko is free software, licensed under the [GNU General Public License v3.0 or later](LICENSE).

As an additional permission under GPLv3 section 7, Kinshoko may be linked and distributed with ONNX Runtime and Microsoft DirectML, which the tagging subprocess ships alongside the app. See [LICENSE-EXCEPTION](LICENSE-EXCEPTION).

Bundled third-party material keeps its own license:

- The Inter and Source Han Sans SC fonts in [`public/fonts/`](public/fonts/) are under the SIL Open Font License 1.1.
- The agent skills in [`.claude/skills/`](.claude/skills/) are under the MIT License; see [`LICENSE-mattpocock-skills`](.claude/skills/LICENSE-mattpocock-skills).
- The tagging models are not distributed with Kinshoko. They are downloaded at runtime and remain under the licenses stated on their model cards.
