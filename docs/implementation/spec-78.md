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

独立草稿：[PR #100](https://github.com/Yukk1No/kinshoko/pull/100)，基于前置实现分支 `integration/v1`。

T16 已由独立合入代理合入，提交 `35cafbb90ed5d06432fcb7b49f8b539a2f421162`。公开动作测试与真实程序剪贴板检查通过；具体结果及未执行的硬件检查见 [T16 记录](spec-78-t16.md)。代码可供 T17 接入，不表示全增量验收通过。

T02 已合入 `f6705880e51b493d7e84b4b74cd0d2c38e851b37`。统一身份、显式对应和纠正使用真实资料库验证；修正安全模式读取后，正式程序 10 项断言通过。详见 [T02 记录](spec-78-t02.md)。

T01 已合入 `8af63b5934e8467629da0ba8d42f7a75daf50091`。正式前端直接复用认可原型代码；最终前端 219 项检查和正式程序 19 项原生检查通过。同样本对照记录原型自身的返回行为与 headless 调整窗口的舍入限制。原生执行先于最终 T02 合入，具体来源与未验证项目见 [T01 记录](spec-78-t01.md)。

T14 已合入 `20bded04927fdb6ffec2c292d22654003034740f`。Eagle 永久删除记忆、本次允许与回收站显式恢复通过公开动作及正式程序检查；工作区 Rust 548 项、前端 219 项和原生 17 项通过。原生发现的命令许可缺口已修正；永久删除后的迟到详情提示交 T07 核对。详见 [T14 记录](spec-78-t14.md)。

T03 已合入 `29433ed89f5dc1c8caed31e3362b38c99cc87117`。全局显式偏好、默认更新、恢复默认和独立别名已接入正式控件；最终前端 225 项通过，原生 15 项明确绑定许可修复后的 `7113d30`。后续选择器边界只补验前端，不计作该原生来源的覆盖。独立输入的三个原 dirty 文件哈希未变。详见 [T03 记录](spec-78-t03.md)。

T07 已合入 `936b7879725db329be5e1e9015a8d86144fbe4cf`。同一工作区默认聚合全部可用提供方；每份来源先匹配整条查询，再按文件字节去重。任一已知 Adult 来源否决同文件，断连后保留保守否决。Rust 570 项、前端 231 项与正式程序 27 项检查通过。最后启动视角修复仅有 UI 回归及原生构建，原生启动补验留给 T20，不将更早的原生来源冒称覆盖它。T14 迟到详情提示由本单独立修正并补验。详见 [T07 记录](spec-78-t07.md)。

T19 已合入 `d4d045074b8e20c3b33822ed1b24a24154921cbe`，独立格式修正为 `81e8ba04fbce93817f8bfdde8dcd7d6f6f916c61`。私有阶段使用手动安装说明，公开阶段检查与安装共用明确配置门槛。隔离真实 debug NSIS 旧版到新版 `/S /UPDATE` 升级 25 项通过，登记、设置、参考组与持久钉图完整保留。普通交互安装未验证，仅 `/S` 的失败及根因未确认状态保留。实际新包源码为 `5082f31`，最终后合组合由 T20 验证。详见 [T19 记录](spec-78-t19.md)。

T04 旧库名称迁移与 T08 各库独立目录树进行中；T09 接续聚合卡片的明确来源整理，复用结束的 T19 工作树并建立独立分支。实现代理使用各自的工作树和分支，完成后合入最新集成提交，再由独立合入代理合入。每张工单的代码状态和验证状态分别记录。功能工单的代码交付与列明检查完成后可以解除实施依赖；未执行的开发者真机项目继续由 T20 组合验收记录，不计为通过。

2026-10-08 负责人补充：目前没有 Windows 10 测试设备或虚拟机，保留 Windows 10 未验证状态。继续实现能力检查、更新提示及本机 Windows 11 验证，不将缺少环境计为通过。

T14 追加内容库数据库迁移。旧程序不能直接打开已升级的数据库；回退需要升级前备份或兼容新格式的程序，不将代码可回退等同于资料库可回退。实际旧版到新版的升级保留由 T19 独立验证。

所有本轮构建使用各工作树自己的 Cargo target。早期共享 target 曾串用其他分支产物，相关检查已作废并重跑。集成检查也使用独立 target。

T21 依赖真实公开入口与已签名旧、新产物。当前原仓库为私有。这项验收不能由本地模拟或手动安装替代。
