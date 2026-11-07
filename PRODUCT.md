# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要用户是画二次元插画的个人画师，业余和职业都算。其他题材的画师也能用，但功能取舍优先照顾这群人。

他们有两种使用状态，各占一半：闲时逛图、收图，以及画画时临时找参考。

## Product Purpose

Kinshoko 是画师的参考图库，从收集到使用都在这里：发现并收下参考图，打好标签，需要时几秒找到，再钉在画布旁边。

成功的标准是：画师不用离开 Kinshoko 去别处找图，也不用自己整理就能找到图，画画时不被打断。

## Positioning

Kinshoko 的差异在整条链路：收图时自动打标，搜索几秒找到，原图钉在画布旁边，放大清晰，取色准确。单项都可能被别的软件追上，连起来才是 Kinshoko。

## Operating Context

- 画师一边开着绘画软件，一边用 Kinshoko；钉图悬浮在画布上方。
- 来源包括拖入、粘贴、截图、导入文件夹、Eagle 迁入和 pixiv。
- 电脑屏幕可能被别人看到，或者正在直播和共享。

## Capabilities and Constraints

- 只支持 Windows 10/11 x64。界面基于 WebView2，钉图窗口是原生实现（ADR-0013）。
- 界面目前只有简体中文，英文排在 v1.2。
- 现有能力：自动打标、近似查找、资料库与文件夹、参考组、钉图、截图、安全模式、Eagle 迁入、pixiv 订阅。
- 计划中：应用内 pixiv 浏览（#461）。其他方向见 `docs/discovery/roadmap.md`。
- 不存在“当前资料库”，每次保存都明确选择保存目标（ADR-0008）。
- 关闭订阅功能后，不显示入口，也不为它联网。
- pixiv 接口是非官方的，界面要标明，并提示账号风险。
- “全本地、无账号、可离线”不再是产品承诺。可以按需要增加联网功能。目前仍没有 Kinshoko 自己的账号和云端。
- 术语以 `GLOSSARY.md` 为准。

## Brand Commitments

- 名称 Kinshoko，定位语 “Your forbidden library: hoard every reference, find any of them.”
- 书签标和封印书等不可更改的元素见 `design/ui-system/brand-invariants.md`。
- 界面文字规则见 `design/ui-system/interface-text-rules.md`；界面不放说明句，说明放 README 和文档。

## Evidence on Hand

- 真实界面图：`docs/readme/search.png`、`docs/readme/pin.jpg`。
- 标识素材：`design/logo-kit/`。
- 目前没有用户评价、案例或使用数据，不得虚构。

## Product Principles

1. 新功能要接上“收到、找到、钉住”这条链路，接不上的排在后面。
2. 不打断画画。画画时的操作要快，不弹多余的提示。
3. 不让画师在屏幕上社死。安全模式默认开启，它管屏幕显示，不是保密边界。
4. 原图不动。不改写原文件，钉图用原图像素。
5. 由画师亲手决定。保存目标明确选择，人工整理优先于自动结果，pixiv 收藏和关注不做自动写入。
