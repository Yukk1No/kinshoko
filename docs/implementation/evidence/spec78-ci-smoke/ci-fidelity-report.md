# Kinshoko 还原度门槛实验报告

结论：未通过（阈值 ΔE2000 < 1，为假设值；缩略图 128 px）

## 环境

- Windows HDR：未填写；自动色彩管理：未填写；显示器 ICC：未填写
- 备注：无

```json
{
  "app": {
    "kinshoko": "0.1.0",
    "system": {
      "gpus": [
        {
          "CurrentBitsPerPixel": 32,
          "CurrentHorizontalResolution": 1024,
          "CurrentVerticalResolution": 768,
          "DriverDate": "/Date(1150848000000)/",
          "DriverVersion": "10.0.20348.1",
          "Name": "Microsoft Hyper-V Video"
        }
      ],
      "icmAssociations": [],
      "monitors": [
        {
          "Instance": "DISPLAY\\MSH062E\\5&1a097cd8&0&UID5527112_0",
          "Name": "HyperVMonitor"
        }
      ],
      "os": {
        "BuildNumber": "20348",
        "Caption": "Microsoft Windows Server 2022 Datacenter",
        "Version": "10.0.20348"
      },
      "windows": {
        "CurrentBuild": "20348",
        "DisplayVersion": "21H2",
        "UBR": 5622
      }
    },
    "webview2": "131.0.2903.86"
  },
  "page": {
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "devicePixelRatio": 1,
    "screen": {
      "width": 1024,
      "height": 768,
      "colorDepth": 24
    },
    "colorGamut": "srgb",
    "dynamicRangeHigh": false,
    "webglRenderer": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "canvasColorSpace": "display-p3"
  }
}
```

## 样本

| 样本 | 实验 | 1:1 显示 | 门槛 | 最大 ΔE2000（门槛） | 1:1 显示 vs 标称 | 缩略图 vs 标称 | WebView2 直接显示原图 vs 标称（只记录） | 结果 | SHA-256 |
|---|---|---|---|---|---|---|---|---|---|
| p3-v4.jpg | 1 | 原图 | 是 | 0.00 | 0.56 | 0.56 | — | 通过 | `b34aaa80f150a555…` |
| p3-v2.jpg | 1 | 原图 | 是 | 0.00 | 0.56 | 0.56 | — | 通过 | `36ff579c9c0db631…` |
| adobe-rgb.jpg | 1 | 原图 | 是 | 0.00 | 5.24 | 5.24 | — | 通过 | `267538bf2de521c9…` |
| lut-a2b0.png | 2 | 派生图 | 是 | 6.33 | 6.33 | 6.33 | 16.43 | 未通过 | `f29a42554d485721…` |
| lut-lab.png | 2 | 派生图 | 是 | 6.55 | 6.55 | 6.55 | 6.55 | 未通过 | `3c0e3f8763759777…` |
| icc-mismatch.jpg | 2 | 原图 | 是 | 0.00 | 0.49 | 0.49 | — | 通过 | `24a931601bcfb8c3…` |
| cmyk-profile.jpg | 3 | 派生图 | 是 | 7.04 | 7.04 | 7.04 | 16.36 | 未通过 | `38040e506f89a7c4…` |
| ycck-profile.jpg | 3 | 派生图 | 是 | 7.04 | 7.04 | 7.04 | 16.36 | 未通过 | `cbc308b019914181…` |
| cmyk-lab.jpg | 3 | 派生图 | 是 | 6.55 | 6.55 | 6.55 | 6.55 | 未通过 | `a2a95631c4b4b326…` |
| ycck-lab.jpg | 3 | 派生图 | 是 | 6.55 | 6.55 | 6.55 | 6.55 | 未通过 | `6b0c55348ec61ec6…` |
| cmyk-naive.jpg | 3 | 原图 | 是 | 0.38 | 0.55 | 0.55 | — | 通过 | `8c6ab2750e505e75…` |
| gama-045455.png | 4 | 原图 | 是 | 0.00 | 0.16 | 0.16 | — | 通过 | `86dc55fcff345506…` |
| gama-18.png | 4 | 原图 | 是 | 4.43 | 1.95 | 4.36 | — | 未通过 | `2ecf12281e501df8…` |
| gama-chrm-p3.png | 4 | 原图 | 是 | 7.03 | 0.57 | 6.54 | — | 未通过 | `6ce0bc4ad8366774…` |
| srgb-vs-gama.png | 4 | 原图 | 是 | 0.00 | 0.16 | 0.16 | — | 通过 | `c8f8335a83a88695…` |
| cicp-p3.png | 4 | 原图 | 是 | 7.03 | 0.57 | 6.54 | — | 未通过 | `9bd3db6747e0709b…` |
| cicp-over-iccp.png | 4 | 原图 | 是 | 7.03 | 0.57 | 6.54 | — | 未通过 | `978f991506a88606…` |
| png16-p3.png | 5 | 原图 | 是 | 0.00 | 6.54 | 6.54 | — | 通过 | `47bdc85d563827b5…` |
| png16-gray-ramp.png | 5 | 原图 | 否 | — | — | — | — | 只记录 | `00e56e6ec8cfc529…` |
| gray-gamma22.jpg | 5 | 原图 | 是 | 0.33 | 0.15 | 0.25 | — | 通过 | `3185ce57291d3b19…` |
| fine-lines.png | 6 | 原图 | 否 | — | — | — | — | 只记录 | `bfde1e09745d4669…` |
| alpha-edge.png | 7 | 原图 | 是 | 0.37 | 0.60 | 0.60 | — | 通过 | `0a9fca8ef1964597…` |
| alpha-edge.webp | 7 | 原图 | 是 | 0.00 | 0.60 | 0.60 | — | 通过 | `cd6067d7b8a33e49…` |
| orientation-1.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `afa9c1edafcb581f…` |
| orientation-2.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `e2eb7f5ebd14f427…` |
| orientation-3.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `379cf9a220fc1563…` |
| orientation-4.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `c1e3f6b6e55d018e…` |
| orientation-5.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `6202f8e3094a4f37…` |
| orientation-6.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `3eb2de8cd32e239d…` |
| orientation-7.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `1ed99dd1ecf1c090…` |
| orientation-8.jpg | 8 | 原图 | 是 | 0.00 | 0.42 | 0.42 | — | 通过 | `ff96e02863ee4b1b…` |
| orientation-6.png | 8 | 原图 | 是 | 73.32 | 73.25 | 0.33 | — | 未通过 | `caf0a3652ad05e76…` |
| animated.gif | anim | 派生图 | 是 | 0.16 | 0.16 | 0.16 | 0.16 | 通过 | `84186ea84e03679e…` |
| animated.png | anim | 派生图 | 是 | 0.16 | 0.16 | 0.16 | 0.16 | 通过 | `6d5be4b8c197f67b…` |
| animated.webp | anim | 派生图 | 是 | 0.16 | 0.16 | 0.16 | 0.16 | 通过 | `b29d8398af8d0fca…` |
| gain-map.jpg | 13 | 派生图 | 是 | 0.49 | 0.49 | 0.49 | 0.49 | 通过 | `9d270397994debcb…` |
| pq.png | 13 | 派生图 | 否 | — | — | — | — | 只记录 | `373a2dfda6453f52…` |
| hlg.png | 13 | 派生图 | 否 | — | — | — | — | 只记录 | `e0d94e54aeb239ea…` |
