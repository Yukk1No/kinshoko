# 参与 Kinshoko

[English](CONTRIBUTING.md) · **简体中文**

谢谢你愿意帮忙。Kinshoko 由一位维护者主导，首个正式版（v1.0）还在收尾。下面说明怎样参与最省双方的时间。

## 反馈与问题

不写代码也能帮上大忙。使用中遇到的问题，请用 [issue 模板](https://github.com/Yukk1No/kinshoko/issues/new/choose)提交：交互反馈、标签识别错误、兼容性结果。报告 bug 时请附上“设置 → 诊断 → 显示诊断信息”的内容（不含文件名、路径和图片），并写清复现步骤。

提交前先搜一下已有 issue。中文或英文都可以。安全问题不要公开提交，见 [SECURITY.md](SECURITY.md)。

## 提交代码

1. **先开 issue 或在已有 issue 下留言**，说明你想改什么、打算怎么改，等维护者回复后再动手。Kinshoko 的很多行为背后有画师验收和已定的设计决定（见 [docs/adr/](docs/adr/)），先对齐能避免白做。打上 `ready-for-human` 的 issue 适合直接认领。
2. 错字、文档链接坏了这类小修改可以直接提 PR。
3. **PR 的目标分支是 `integration/v1`**，不是 `main`。v1 发布前 `main` 冻结，只经 [PR #71](https://github.com/Yukk1No/kinshoko/pull/71) 接收 v1。
4. 一个 PR 只做一件事，在描述里链接对应 issue（`Closes #123`），并写明怎样验证的。改了界面请附应用窗口的截图。
5. CI 全绿后由维护者合并。

提交的代码按本仓库的 [GPL-3.0-or-later](LICENSE) 授权，并适用 [LICENSE-EXCEPTION](LICENSE-EXCEPTION) 中的附加许可。

## 开发环境

- Windows 10/11 x64，Visual Studio 2022 生成工具（“使用 C++ 的桌面开发”）。
- Rust 1.95（由 `rust-toolchain.toml` 固定，rustup 会自动安装）。
- Node.js 22 与 npm（锁文件为 `package-lock.json`）。
- WebView2 Runtime（evergreen）。Windows 11 自带。
- Python 3：用于 pre-commit 钩子和 `scripts/probe/` 下的探测脚本。

克隆后启用仓库的 git 钩子（拦截超过 5,000 token 的暂存文件）：

```sh
git config core.hooksPath .githooks
```

## 常用命令

```sh
npm ci                  # 安装前端依赖
npm run dev             # 开发模式启动应用（Vite 开发服务器 + 调试版应用）
npm run build           # release 构建，生成 NSIS 安装包到 target/release/bundle/nsis/
npm test                # 前端测试（Vitest）
npm run typecheck       # TS 类型检查
npm run bindings        # 跑核心 crate 测试，并重新生成 src/bindings/
cargo test -p kinshoko-core
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings   # 需先 npm run vite:build 产出 dist/
node e2e/smoke.mjs target/release/kinshoko.exe msedgedriver.exe   # 需 tauri-driver 与匹配 WebView2 版本的 msedgedriver
```

CI 在 `windows-2022` 上运行 Rust 检查（格式、Clippy、核心 crate 测试、生成物检查）以及原生应用构建与 WebDriver 冒烟测试，在 `ubuntu-latest` 上运行 TS 类型检查、前端测试与工作流检查；应用这一组固定在 `windows-2022`，因为冒烟测试在 `windows-latest` 上还过不了，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。提 PR 前请在本地跑过对应的检查。

## 目录

| 路径 | 内容 |
| --- | --- |
| `crates/kinshoko-core/` | 领域核心 crate，不依赖 Tauri。领域逻辑都放这里，测试在它的对外接口上用临时目录里的真 SQLite 与真文件。 |
| `crates/kinshoko-tagger/` | 打标子进程：ONNX Runtime + DirectML 推理，没有独显时走 CPU。 |
| `src-tauri/` | Tauri 2 应用壳（crate `kinshoko`）。命令层只做转发、类型转换和事件推送。 |
| `src/` | React 19＋TS＋Vite 前端；`src/ipc.ts` 是调用 Tauri 命令的唯一入口。 |
| `src/bindings/` | ts-rs 从核心 crate 生成的前后端契约类型，**不要手改**，生成后提交。 |
| `e2e/` | Tauri WebDriver 冒烟测试（建库、导入、浏览、重开），只用 Node 自带模块。 |
| `tools/`、`prototype/` | 独立的探测工具与原型，各带自己的锁文件，不在 Cargo 工作区内。 |
| `design/` | Logo、界面系统与设计探索；取用资产只从 `design/logo-kit/` 与 `design/ui-system/`。 |
| `docs/` | 领域讨论（`discovery/`）、调研（`research/`）、ADR（`adr/`）与验收（`validation/`）。 |

## 开发时要知道的事

- **应用常驻托盘。** 关闭主窗口只销毁 WebView，从托盘菜单“退出”才结束进程。
- **程序数据在程序目录下的 `data\`。** 设置、打标模型等都在这里，开发时是 `target\debug\data\`（[ADR-0009](docs/adr/0009-portable-data-root.md)）。测试时用环境变量 `KINSHOKO_DATA_DIR` 换到别的目录。
- **开机自启。** 调试构建不写系统的开机自启登记；手动测试 release 构建时设置 `KINSHOKO_SKIP_AUTOSTART=1` 达到同样效果。
- **前后端契约。** 改了带 `#[ts(export)]` 的 Rust 类型后运行 `npm run bindings` 并提交生成物；CI 会检查生成物与提交内容一致。
- **从不改写原图。** 任何改动都不能修改资料库里原图的字节。

## 约定

- **术语。** 代码、界面文案与文档使用 [GLOSSARY.md](GLOSSARY.md) 里的词。新概念或改了含义的词先更新词条。
- **决定。** 难以回退的决定写成 ADR，放在 [docs/adr/](docs/adr/)。
- **界面。** 界面改动遵循 [`design/ui-system/`](design/ui-system/README.md) 的组件、令牌与文案规则；logo 与封印书沿用原样。
- **提交信息。** 用 `类型(范围): 说明` 的格式，类型如 `feat`、`fix`、`docs`、`ci`、`chore`；说明可以用中文。
- **隐私。** 仓库是公开的。不要提交整个桌面的截图、带个人路径或用户名的日志、真实画师的图库内容。截图只截应用窗口，测试素材用合成图或可以公开再分发的图片。

## AI 编程助手

仓库为 AI 编程助手准备了说明和 skills，入口是 [AGENTS.md](AGENTS.md)。用 AI 助手写的 PR 同样要先对齐 issue，并由你本人确认改动、跑过检查。
