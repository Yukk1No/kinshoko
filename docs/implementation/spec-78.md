# #78 独立增量实施

规格：[增量规格 #78](https://github.com/Yukk1No/kinshoko/issues/78)。

集成分支：`codex/spec-78-integration`。

前置代码基线：`536cc43c1933e44fc33836f8a439de8cdb0da018`。

## 用户实施备注

2026-10-08：直接参考 prototype 的代码，或在 prototype 代码上修改后接入正式程序。认可原型是正式前端的代码和体验来源。实施记录注明复用的来源、保留的行为和实际对接结果。

认可浏览原型的固定来源为提交 `bd8aea44c4a311571ee3c07382cb7755f87f3153` 中的 `prototype/reference-browser`。认可依据为 [#13 最终结论](https://github.com/Yukk1No/kinshoko/issues/13#issuecomment-6010877424)、[PR #25](https://github.com/Yukk1No/kinshoko/pull/25) 和 [PR #35](https://github.com/Yukk1No/kinshoko/pull/35)。

## 任务边界

- 本轮按 21 张增量工单的阻塞关系实施。后续工单归属 #78。
- #42、#71、旧子工单与原验收记录继续按原有范围保存，不改写、不回算完成状态。
- 旧实现可以复用。旧测试报告只作历史基线。
- 公开后的签名自动更新实测有独立外部条件。当前实施不改变仓库可见性、不发布 Release、不合并前置 PR、不生成或配置生产签名私钥。

## 已确认的验证边界

- Rust 核心公开接口，配合真实 SQLite 资料库和真文件。
- 正式程序端到端操作。既有前端行为测试作为补充检查。
- 开发者真机验收。原型只用于体验对照。

每份新证据记录故事、提交、环境、步骤和结果。未执行的原生或硬件检查保持未验证。每个功能工单先交付自己的检查结果，组合验收补充跨流程行为。

## 实施状态

进行中。GitHub 回读确认 21 张子工单、27 条原生阻塞关系，工单正文与发布副本一致。

| 计划 | 工单 | 交付 |
|---|---|---|
| T01 | [#79](https://github.com/Yukk1No/kinshoko/issues/79) | 认可原型的正式前端基线 |
| T02 | [#80](https://github.com/Yukk1No/kinshoko/issues/80) | 统一标签身份 |
| T03 | [#82](https://github.com/Yukk1No/kinshoko/issues/82) | 全局显示名称偏好 |
| T04 | [#83](https://github.com/Yukk1No/kinshoko/issues/83) | 旧库名称迁移 |
| T05 | [#84](https://github.com/Yukk1No/kinshoko/issues/84) | 全局标签分组 |
| T06 | [#85](https://github.com/Yukk1No/kinshoko/issues/85) | 全局个人近似规则 |
| T07 | [#86](https://github.com/Yukk1No/kinshoko/issues/86) | 安全的跨库聚合查询 |
| T08 | [#87](https://github.com/Yukk1No/kinshoko/issues/87) | 各库独立目录范围 |
| T09 | [#88](https://github.com/Yukk1No/kinshoko/issues/88) | 聚合卡片的明确来源 |
| T10 | [#89](https://github.com/Yukk1No/kinshoko/issues/89) | 导入与收藏目标 |
| T11 | [#90](https://github.com/Yukk1No/kinshoko/issues/90) | 参考组包标签定义依赖 |
| T12 | [#91](https://github.com/Yukk1No/kinshoko/issues/91) | 内容库备份与恢复 |
| T13 | [#92](https://github.com/Yukk1No/kinshoko/issues/92) | 程序设置备份与替换恢复 |
| T14 | [#93](https://github.com/Yukk1No/kinshoko/issues/93) | Eagle 永久删除重导选择 |
| T15 | [#94](https://github.com/Yukk1No/kinshoko/issues/94) | 本次封印重复项预览 |
| T16 | [#81](https://github.com/Yukk1No/kinshoko/issues/81) | 查看器与钉图的原图框选 |
| T17 | [#95](https://github.com/Yukk1No/kinshoko/issues/95) | 瀑布流的稳定原图框选 |
| T18 | [#96](https://github.com/Yukk1No/kinshoko/issues/96) | Windows 运行时能力 |
| T19 | [#97](https://github.com/Yukk1No/kinshoko/issues/97) | 私有与公开更新阶段 |
| T20 | [#98](https://github.com/Yukk1No/kinshoko/issues/98) | 组合操作与开发者真机验收 |
| T21 | [#99](https://github.com/Yukk1No/kinshoko/issues/99) | 公开后的真实签名更新验收 |

首批实现为 T01、T02、T16。实现代理使用各自的工作树和分支。独立合入代理将结果合入本轮集成分支。每张工单的合入提交和验证记录单独保存。

T21 依赖真实公开入口与已签名旧、新产物。当前原仓库为私有。这项验收不能由本地模拟或手动安装替代。
