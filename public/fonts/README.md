# 随软件分发的字体

沿用 [#28 字体方案](../../docs/research/font-rendering-and-selection.md)：Inter 4.1 的静态 hinted 400／500／600，完整 Source Han Sans SC VF 2.005R。文件直接取自官方固定版本，没有裁字或修改轮廓；Vite 将此目录复制进应用，离线可用。

| 文件 | 来源 | SHA-256 |
|---|---|---|
| `Inter-Regular-hinted.woff2` | [Inter 4.1 ZIP](https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip) 的 `extras/woff-hinted/Inter-Regular.woff2` | `338239f6b590b8ced3bf857654d32da3fd3663294cd3003651ed57aa3abd7aa1` |
| `Inter-Medium-hinted.woff2` | 同一 ZIP 的 `extras/woff-hinted/Inter-Medium.woff2` | `7e80d9f65861ee6836a0081d4e75d88fb8789e5651d05edbc49640442a9610ee` |
| `Inter-SemiBold-hinted.woff2` | 同一 ZIP 的 `extras/woff-hinted/Inter-SemiBold.woff2` | `5013f48d77ab627b1db7c2415914284ef09abc3f60a8e0d0d8f3cd1bfebefb5e` |
| `SourceHanSansSC-VF.ttf.woff2` | [Source Han Sans 2.005R](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/Variable/WOFF2/TTF/SourceHanSansSC-VF.ttf.woff2) | `cfec773cdc2ea964de8713471c6fd20774bc40617f5567f92efeeccaca6604b0` |

版权与 SIL Open Font License 1.1 原文随字体保留在 `Inter-LICENSE.txt`、`SourceHanSans-LICENSE.txt`，构建与分发时一并复制。
