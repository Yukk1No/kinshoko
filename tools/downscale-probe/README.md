# Kinshoko 缩小对比

在你自己的屏幕上比较两种缩小算法生成的缩略图，选出更还原的一种，生成一份报告发给开发者。对应 [#48](https://github.com/Yukk1No/kinshoko/issues/48)。

## 使用

1. 解压整个文件夹，双击 `kinshoko-downscale-probe.exe`。不需要安装，Windows 11 自带它要用的 WebView2。
2. 读完说明点“开始”。第一次运行会下载 8 张 pixiv 公开线稿（约 4 MB），已下载过的不会重复下载；没有网络时只比较程序画的线稿。
3. 每一组左右显示同一张图用不同算法缩小的结果，按屏幕像素 1:1 显示。选出你觉得更还原、更像原图的一边，看不出就选“看不出区别”，可以留言。
   - 图比窗口大时拖动或滚动来看其他部分，左右一起移动；
   - “对照原图”（或按住 <kbd>O</kbd>）在同一位置按原图 1:1 显示；
   - 键盘：<kbd>1</kbd> 左边、<kbd>2</kbd> 看不出、<kbd>3</kbd> 右边，<kbd>Enter</kbd> 或 <kbd>→</kbd> 下一组，<kbd>←</kbd> 上一组。
4. 做完写下整体感受，点“保存报告”。桌面上会出现 `kinshoko-缩小对比报告-<数字>.zip`，把它发给开发者。

请保持平时作画时的显示器设置。报告只包含每组的选择、留言、用时、缩略图的哈希、随机种子和屏幕信息（缩放比例、分辨率、色域、HDR、WebView2 与 Windows 版本），不含文件名和图片，也不读取你自己的图片。样本与 WebView2 的数据保存在 `%LOCALAPPDATA%\Kinshoko\downscale-probe`，不需要时可以整个删除。

## 它比较什么

两种缩略图都由 Kinshoko 自己的还原度管线生成（`kinshoko_core::fidelity::render_sdr`，色彩管理、预乘 alpha、Lanczos3），只换缩小所在的空间：

- **线性光**：把编码值还原成光的强度再平均，物理上正确；白底黑细线缩小后更浅、更细。
- **编码值空间**：直接平均编码值，与多数绘画软件、浏览器相同；细线保持更深、更实。

每个样本缩小到宽度的 1/3 与 1/7.5 各一组（核查“尚未验证”一节实验 6）。样本是程序画的 5 张线稿（0.5～6 px 黑线、排线与网点、彩色线、深色底上的浅线、草图笔画）和公开样本清单里 8 张全年龄线稿。左右与组的顺序按随机种子打乱，种子写进报告。

缩略图画在 sRGB float16 画布上，按设备像素 1:1 复制，不经浏览器缩放（与钉图相同的做法；开发机 110% 实测屏幕像素与缩略图逐像素一致）。

## 开发

```
cargo test
cargo run --release -- --samples-dir ../../samples/pixiv   # 用本机的公开样本，不下载
cargo run --release -- --no-download                       # 只用构造样本
cargo run --release -- --dump <目录>                        # 写出构造样本与两种缩略图
cargo run --release -- --self-test [目录]                   # CI 自测，不开窗口
```

本工具有自己的 `Cargo.lock`，不在根工作区里；它按路径依赖 `crates/kinshoko-core`，CI 在 `tools/downscale-probe/**` 或 `crates/kinshoko-core/src/fidelity/**` 改动时构建、测试、打包并自测，产物上传为 artifact。
