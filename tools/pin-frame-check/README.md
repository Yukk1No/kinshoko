# pin-frame-check（开发工具）

原生钉图（ADR 0013、#283）的逐帧核对与平台层验收：用 `kinshoko-core` 的 `frame::plan` 决定每一帧重画、平移还是换窗，`pin-render` 画一张测试钉图（品红边框为短边的 5%，里面绿色棋盘，在内存里生成），经 `pin-shell` 的 Windows 适配器上屏。DXGI 桌面复制每合成一帧取一次，只把钉图附近一小块读回内存，检查品红外框是否正好是某一次提交；报告只有数字，不存截图。

不进发布包，不进 workspace（`Cargo.toml` 里有空的 `[workspace]`，自带 `Cargo.lock`）。核对部分从原型 `prototype/pin-gpu-wgpu` 的 `verify.rs` 搬来。

## 命令

会在屏幕上弹出置顶钉图；`--input-test` 和 `scripts/run-all.sh` 还会动真实鼠标键盘、启动 Edge。**先确认没人在用电脑。**

```bash
cargo build --release
```

```bash
target/release/kinshoko-pin-frame-check.exe --selftest <报告.txt> --verify
```

自测（原型的全部场景）：滚轮一格一帧放大到比屏幕大再缩回、每帧三格、隔 150 ms 一格、拖出屏幕一半再拖回、旋转翻转、动画、比屏幕大时拖动与缩放、透明度。报告含各阶段的重画／平移／换窗次数与耗时、`swap` 本身与 `swap → Swapped` 的分布、界面线程每条窗口消息的处理时间、逐帧核对结论（“对不上的帧”验收要求为 0）。对不上时退出码为 2。

- `--naive`：对照组，只用一个槽，每帧改窗口尺寸再 Present；`--present-first` 反过来。核对应当抓到错位。
- `--hold MS`：钉住一段时间，打印内存、显存与 QUNS；`--count N` 张、`--fill` 放到盖满屏幕。
- `--input-test`：前台放一个收键窗口（本程序的子进程），SendInput 拖动、滚轮、按 H/V/R，检查前台不变、键归谁、阴影与窗口外的命中、点击穿透。
- `--region-test`：给看得见的槽设一个比内容小的窗口区域，看区域外的 DComp 内容与点击还在不在（“包络里接住点击”的试验）。
- `--device-loss`：模拟 GPU 设备丢失，渲染层重建、平台层 `retarget`，量多久重新显示。
- `--info`：显卡、刷新周期、QUNS、建设备前后的内存。

```bash
bash scripts/run-all.sh <输出目录>
```

一次跑完：两轮自测、两组对照、设备丢失、窗口区域、1／5／10 张与盖满屏幕的内存与 QUNS、背后最大化的 Edge（独立配置目录，`--disable-extensions --disable-sync`，CDP 读 `visibilityState` 与 rAF，要 Node）、真实输入与焦点。

桌面复制在显示器休眠或锁屏时取不到帧，报告里“核对 0 帧”说明结论无效，要重跑。
