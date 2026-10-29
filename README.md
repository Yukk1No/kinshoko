<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo-kit/lockups/horizontal-night.svg">
    <img alt="Kinshoko" src="design/logo-kit/lockups/horizontal-day.svg" width="320">
  </picture>
</p>

<p align="center">
  Keep, find and pin your drawing references.
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

Kinshoko is a reference tool for illustrators. Save images you like as you come across them and Kinshoko tags them for you; when you sit down to draw, search for what you need and pin it next to your canvas.

> [!NOTE]
> Kinshoko is in **beta**. It runs on Windows 10/11 x64 only, and the interface is in Simplified Chinese. Keep your own copy of your images until backups are verified on your machine.

## Features

- **Pin next to your canvas.** Pin a whole image, part of one, or anything on screen above your painting app. Flip, rotate, fade or lock a pin so you don't click it by accident, and push it to the screen edge when it's in the way. Pins stay up after you close the main window.
- **Save images in a moment.** Drag them in, paste, take a screenshot, or import a whole folder. The same image is only stored once.
- **Automatic tags.** New images are tagged with things like hair color, outfit and pose, so you don't have to type them in. Fix any tag whenever you like.
- **Find what you want to draw.** Search in Chinese. A search for blue eyes also brings in close matches such as aqua eyes, and you can switch back to exact matching.
- **Reference groups.** Keep the references for one piece together as a group and bring them back next time.
- **Safe mode.** On by default. Adult images won't pop up on your screen, so streaming or sharing your screen stays safe.
- **Your images stay on your computer.** No account, works offline, and your original files are never changed. Back up to another drive and check that everything comes back.
- **Separate libraries.** Keep work and personal references apart and switch between them.
- **Move over from Eagle.** Bring an existing Eagle library over with its tags and folders.

Planned directions, such as image similarity search, semantic search, color search and multi-device sync, are listed in the [roadmap](docs/discovery/roadmap.md) (in Chinese).

## Install

1. Download `Kinshoko_<version>_x64-setup.exe` from [Releases](https://github.com/Yukk1No/kinshoko/releases).
2. Run it. The installer installs for the current user only and does not need administrator rights. It installs the Microsoft Edge WebView2 runtime if missing (Windows 11 already includes it).
3. Windows SmartScreen may say "Windows protected your PC" because the installer is not code-signed yet. If you downloaded it from this repository's Releases page, choose **More info → Run anyway**.

Kinshoko checks for updates from GitHub Releases and verifies each update's signature before installing it. Uninstalling never deletes your libraries.

The tagging model is not bundled. Kinshoko downloads it from Hugging Face the first time automatic tagging runs, and shows the download size first.

## Privacy

Kinshoko works offline on your own machine. There is no telemetry and no account. Kinshoko connects to the network only to:

- check for and download updates from GitHub Releases;
- download the tagging model from Hugging Face, once;
- let the installer download the Microsoft Edge WebView2 runtime from Microsoft, only if it is missing.

The diagnostics in **设置 → 诊断** (Settings → Diagnostics) list only system, GPU, WebView2 and display information, never file names, paths or images, so you can paste them into an issue. **存成文件…** (Save as file) bundles them with the last 7 days of the run log (运行日志) into a zip. The run log records errors, warnings and the timing of captures, pins, tagging and windows, never file names, paths, tag text or images. It stays on your machine, keeps at most 7 days or 20 MB, and is on by default only in test builds.

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
- The Fluid Functionalism code in [`src/ui/vendor/fluid/`](src/ui/vendor/fluid/) is under the MIT License; see its [`LICENSE`](src/ui/vendor/fluid/LICENSE).
- The agent skills in [`.claude/skills/`](.claude/skills/) are under the MIT License; see [`LICENSE-mattpocock-skills`](.claude/skills/LICENSE-mattpocock-skills).
- The tagging models are not distributed with Kinshoko. They are downloaded at runtime and remain under the licenses stated on their model cards.
