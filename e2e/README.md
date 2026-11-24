# e2e

真实应用的原生脚本：用 tauri-driver 与 msedgedriver 驱动 WebView2，需要先构建好 `kinshoko.exe`。CI 只跑“常驻”的两个；其余自己手动跑，不保证现在还能通过，改到相关界面时顺手跑一遍。

通用参数：`<kinshoko.exe>` 是构建出的程序，`<msedgedriver.exe>` 要与本机 WebView2 版本一致，`tauri-driver` 要在 PATH 中（`cargo install tauri-driver --locked`）。构建时用独立的 identifier，避免单实例插件把脚本连到正在用的应用上。各脚本的参数以文件头注释为准。

## 类别

| 类别 | 含义 | 维护 |
| --- | --- | --- |
| 常驻 | CI 或发布清单在跑 | 持续维护 |
| 手动验收 | `docs/validation/` 里的文档点名 | 改到相关界面时维护 |
| 依赖 | 被上面的脚本 import 或读取，不单独运行 | 跟着引用它的脚本 |
| 保留 | 对应 issue 还没关闭 | issue 关闭后清掉 |
| 待定 | 维护者 2026-11-13 决定先留下，以后再判 | — |
| 共用 | `lib/`：驱动与测试图的共用模块（#521） | 跟随使用它的脚本 |

## 脚本

| 脚本 | 类别 | 怎么跑 |
| --- | --- | --- |
| `smoke.mjs` | 常驻 | `node e2e/smoke.mjs <kinshoko.exe> [msedgedriver.exe] [tauri-driver.exe]` |
| `fidelity-gate.mjs` | 常驻 | `node e2e/fidelity-gate.mjs <kinshoko.exe> [报告目录]` |
| `viewer.mjs`、`viewer.helpers.mjs` | 手动验收 | `node e2e/viewer.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]`（helpers 只被 import） |
| `viewer-zoom-perf.mjs` | 手动验收 | `node e2e/viewer-zoom-perf.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]` |
| `native-standalone-guard.mjs`、`native-standalone-guard.test.mjs` | 依赖 | guard 被 viewer 类脚本 import；测试 `node --test e2e/native-standalone-guard.test.mjs` |
| `spec78-combination-preflight.mjs`、`-build.mjs`、`-known-folder.mjs`、`-fixture.mjs` | 依赖 | 由 guard 引入，不单独运行 |
| `eagle-deletion-choice.mjs` | 依赖 | `spec78-combination-fixture.mjs` 会读取它的源码做校验，所以不能删；也可单独跑：`node e2e/eagle-deletion-choice.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]` |
| `image-sets-418.mjs`、`image-sets-418.fixture.mjs` | 保留（#418） | `node e2e/image-sets-418.mjs …`，参数与 `--record` 见文件头 |
| `import-wall-perf.mjs` | 待定 | 先用 `scripts/perf/wall-fixture.mjs` 生成样本，用法见文件头 |
| `wall-delete-perf.mjs` | 待定 | 同上，用法见文件头 |
| `button-material.mjs` | 待定 | `node e2e/button-material.mjs <kinshoko.exe> <msedgedriver.exe> <输出目录>` |
| `inspector-sources.mjs` | 待定 | `node e2e/inspector-sources.mjs <kinshoko.exe> <msedgedriver.exe> <输出目录>` |
| `save-destination.mjs`、`save-destination.helpers.mjs`、`save-destination-followup.mjs` | 待定 | `node e2e/save-destination.mjs <kinshoko.exe> <msedgedriver.exe>`；`-followup` 同参数 |
| `spec78-frontend.mjs`、`.helpers.mjs`、`.steps.mjs` | 待定 | `node e2e/spec78-frontend.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]` |
| `spec78-prototype.mjs` | 待定 | `node e2e/spec78-prototype.mjs <msedgedriver.exe> [输出目录]`；`design/prototype/README.md` 用它生成对照样本 |
| `lib/driver.mjs`、`lib/fixtures.mjs` | 共用 | 不单独运行 |

`spec78-frontend.mjs` 与 `spec78-prototype.mjs` 的默认输出目录 `docs/implementation/evidence/spec78-t01` 已不在仓库里（见下）；跑之前给一个输出目录。

## 新写的一次性验收脚本

放在 `e2e/` 外的 `work/`（已忽略，不入库），或随对应 PR 提交、在该 issue 关闭后的下一次清理里删掉。要长期留的，先在 `docs/validation/` 写明用途，再放进 `e2e/` 并加到上表。

## 已归档

- 一次性脚本（文件名带 issue 编号或规格 78 工单号，对应 issue 已关闭）已删除，history 里找得到。
- 规格 78 的验收证据 `docs/implementation/evidence/` 已从主干删除，找回：`git checkout archive/spec-78-evidence -- docs/implementation/evidence`。
