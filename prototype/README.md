# 原型入口

## 当前体验基线

`reference-browser/` 从固定提交 `bd8aea44c4a311571ee3c07382cb7755f87f3153` 恢复。
认可依据是 [#13 最终结论](https://github.com/Yukk1No/kinshoko/issues/13#issuecomment-6010877424)、[PR #25](https://github.com/Yukk1No/kinshoko/pull/25) 和 [PR #35](https://github.com/Yukk1No/kinshoko/pull/35)。

2026-10-08 负责人要求直接复用原型代码或在原型代码上接入正式程序。本目录保留原型的实际可运行源码。原始 README 中“代码只用于这次试用，不作为正式应用的起点”是历史范围说明；本轮以负责人的新指示为准。

运行：在 `prototype/reference-browser` 执行 `npm ci`、`npm run dev`。原始 `README.md` 与 `DESIGN-NOTES.md` 保留其样本准备、字体与试用说明。

本轮同样本对照：先运行仓库根目录 `e2e/spec78-frontend.mjs`，它通过正式公开 IPC 读取真实导入的样本顺序，并在 `.local` 生成原型样本与离线字体。随后运行 `e2e/spec78-prototype.mjs`。自制 PNG 可以重分发；私人原图不随源码提交。

## 历史专项探针

旧 #5／#7／#14／#15 等选型、钉图、窗口动作与三方案探针只保留在历史提交和对应工单中。它们用于解释专项试验，不能作为当前正式程序的验证结果。

本轮前端复用清单、行为证据与未验证项见 [T01 实施记录](../docs/implementation/spec-78-t01.md)。

## #78 新增对齐来源

[spec78-alignment/](spec78-alignment/README.md) 保存负责人 Q17 / Q26–28 使用的标签名称、资料库工作区和文件夹工作区 HTML 原稿与哈希。它们服务后续 T03 / T07 / T08 / T10；与旧浏览体验认可基线分别记录。
