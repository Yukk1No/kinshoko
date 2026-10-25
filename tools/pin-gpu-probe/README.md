# pin-gpu-probe（丢弃型原型）

问题：每张钉图一个原生窗口，渲染走跨平台 GPU 抽象（wgpu＋WGSL），能不能做到逐帧 0 错位、不抢焦点、不挡 Chromium、不触发全屏判定。结论和数据见 [`docs/discovery/pin-gpu-design.md`](../../docs/discovery/pin-gpu-design.md)。

不接正式代码，不进 workspace（`Cargo.toml` 里有空的 `[workspace]`）。

## 结构

| 文件 | 内容 | 平台相关 |
|---|---|---|
| `src/geom.rs` | 钉图几何与“这一帧怎么上屏”（`plan`），纯函数＋单测；正式方案放进 `kinshoko-core` | 否 |
| `src/gpu.rs`、`src/pin.wgsl`、`src/mip.wgsl` | wgpu 渲染：上传、GPU 生成 mip、一次全屏三角形画内容＋阴影＋透明度 | 否（只吃 `SurfaceTargetUnsafe`） |
| `src/shell.rs` | `Shell` trait 与 Windows 实现：每张钉图两个槽窗口、DComp 一次提交换槽、输入 | 是（唯一的 `unsafe` 平台代码） |
| `src/verify.rs` | 逐帧核对（DXGI 桌面复制，只读回钉图附近，不存盘） | 是（测量用） |
| `src/sys.rs` | QPC、刷新周期、QUNS、内存与显存 | 是（测量用） |
| `src/main.rs`、`src/app.rs`、`src/selftest.rs`、`src/modes.rs` | 命令行、钉图状态与上屏、自测与报告、停留与输入测试 | — |

## 命令

会在屏幕上弹出置顶钉图、动真实鼠标：先确认没人在用电脑。

```bash
cargo test
```

```bash
cargo build --release
```

```bash
target/release/kinshoko-pin-gpu-probe.exe --gen <目录>
```

生成 `marker.png`（4000×6000，品红边框为短边 5%，内部绿棋盘）。

```bash
target/release/kinshoko-pin-gpu-probe.exe --selftest <报告.txt> --verify <目录>/marker.png
```

自测（滚轮、连滚、慢滚、拖出屏幕再拖回、旋转翻转、动画、比屏幕大时拖动缩放、透明度），`--verify` 同时逐帧核对。`--naive` 换成对照组（一个窗口，每帧 `SetWindowPos`＋Present），`--present-first` 把两步顺序反过来。`NATIVE_PIN_DUMP=<目录>` 时对不上的帧把读回的那一小块存成 PNG。

```bash
bash scripts/run-all.sh <输出目录>
```

一次跑完全部：两轮自测、两组对照、1／5／10 张与盖满屏幕时的内存显存、背后最大化 Edge（独立配置目录、CDP 读 visibilityState 与 rAF）、QUNS、真实鼠标拖动滚轮与焦点（前台放画图）。

其他：`--hold MS`（显示后停留，打印内存、QUNS）、`--count N`、`--fill`（放大到盖满屏幕）、`--full-screen-ok`（不让出最下面一行）、`--info`、`--input-test`、`--scale`。环境变量 `PROBE_MEMHINT=perf` 换回 wgpu 默认的大块显存分配。
