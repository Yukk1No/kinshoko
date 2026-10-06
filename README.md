# Kinshoko（暂定）

为二次元画师探索从收集、整理、查找图片到实际绘画参考的开源软件。

当前处于领域对齐阶段。项目名称、产品边界、数据模型、首版范围和技术方案仍待讨论。

- [初始设想](docs/discovery/initial-brief.md)：讨论输入，尚未形成规格。
- [已有调研](docs/research/anime-library-research.md)：2026-09-30 的候选软件调查与证据。
- [数据实践调查](docs/research/data-model-practices.md)：Eagle 与参考项目的实际存储、导入、合并和参考板实现。
- [验收约定](docs/validation/acceptance.md)：首个本地版本的样本、客观门槛与画师反馈方式。
- [数据与存储模型提案](docs/discovery/data-storage-model.md)：融合两份方案的身份、元数据、参考组、引用迁移与备份建议；配有 [层级图](docs/discovery/data-hierarchy.md)，区分共识与未决规则。

仓库已配置 Matt Pocock engineering skills，使用 GitHub Issues 与默认 triage 标签；配置入口见 [AGENTS.md](AGENTS.md)。当前通过 grilling 与 domain-modeling 对齐领域和首版目标。

## 开发

首版规格见 [#42](https://github.com/Yukk1No/kinshoko/issues/42)，技术路线见 [technical-route.md](docs/discovery/technical-route.md) 与 [ADR-0004](docs/adr/0004-tech-stack-and-process-model.md)。

### 目录

| 路径 | 内容 |
| --- | --- |
| `crates/kinshoko-core/` | 领域核心 crate，不依赖 Tauri。领域逻辑都放这里，测试在它的对外接口上用临时目录里的真 SQLite 与真文件。 |
| `src-tauri/` | Tauri 2 应用壳（crate `kinshoko`）。命令层只做转发、类型转换和事件推送。 |
| `src/` | React 19＋TS＋Vite 前端；`src/ipc.ts` 是调用 Tauri 命令的唯一入口。 |
| `src/bindings/` | ts-rs 从核心 crate 生成的前后端契约类型，**不要手改**，生成后提交。 |
| `e2e/` | Tauri WebDriver 冒烟测试（建库、导入、浏览、重开），只用 Node 自带模块。 |
| `tools/`、`prototype/` | 独立的探测工具与原型，各带自己的锁文件，不在 Cargo 工作区内。 |

### 环境

- Windows 10/11 x64，Visual Studio 2022 生成工具（“使用 C++ 的桌面开发”）。
- Rust 1.95（由 `rust-toolchain.toml` 固定，rustup 会自动安装）。
- Node.js 22 与 npm（锁文件为 `package-lock.json`）。
- WebView2 Runtime（evergreen）。Windows 11 自带；安装包在缺失时用 bootstrapper 联网安装。

### 常用命令

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

改了跨前后端的 Rust 类型（带 `#[ts(export)]`）后运行 `npm run bindings` 并提交生成物；CI 会重新生成并检查与提交内容一致。CI 在 `windows-latest` 上依次运行格式检查、Clippy、核心 crate 测试、生成物检查、TS 类型检查、前端测试与 Tauri 原生构建，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。
