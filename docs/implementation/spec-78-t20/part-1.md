# 78 T20 — 最终组合验收（1/4）

[返回索引](../spec-78-t20.md)

## 界面准备

产品提交：`67765bed472a0037aae62c193d815bebcf5533b9`，tree `09eac8686df761126e0c7b411d8afa65c7892b6d`。基于集成 `b8561a8fbe9671e78f8acf12126e74ba6815fbfc`。

- 标签分组保留正在输入的编辑器及其焦点。词表或工作区刷新时隐藏失效的服务端名称、来源、成员和候选。真实安全模式变化及目标组删除仍关闭草稿。没有忽略相同库内词表 revision 的通知。
- 手动更新说明改为“当前使用安装包手动更新。”。说明表达此构建的实际行为，不推断远端仓库可见性。更新阶段、签名及 endpoint 限制保持原样。
- 参考组侧栏直接参考认可原型 `bd8aea44c4a311571ee3c07382cb7755f87f3153` 的 `pane-body`／`group-card`。使用可用满高和纵向卡片，长名称、导出路径、原因和成员状态换行。旧 T11 两张原生截图与当前40vh源码支持该修正；当时最终来源的实际视觉尚未验证，后来由 r21–r23 的原生轮次与审阅截图（`03-reference-sidebar-long-name-and-path.png`）核对。

## 已执行检查与保留失败

检查接口是实际 App DOM、官方 Tauri IPC/event 模拟以及核心公开 `UpdatePolicy`。jsdom 结果不代表真实 SQLite、窗口、显示或剪贴板结果。

- 标签选择器：无夹具错误 RED 1失败；修复后定向1成功；6项公开回归与既有分组流程合计3文件22成功。
- 更新策略：RED 2成功／1失败；GREEN3成功。真实 Rust绑定导出193成功。
- 冻结产品提交的定向界面检查：5文件37成功／1失败。运行前后核对564份实际文件，0变化，Git为空。
- 该失败发生在旧 `TagOrganize` 的加标签按钮前置条件。标题出现不保证迟到刷新结束。只改为等待精确按钮出现且可用。没有增加超时或固定延时。修正后的2文件17成功基于同产品及一份改动的测试；最终同源综合结果尚未执行。
- 第一轮清理夹具产生的13条 unlistener错误、无夹具错误 RED、冻结失败和修正结果分别保留。后续成功不清除原件。

最小派生记录：[ui-preparation.json](../evidence/spec78-t20/ui-preparation.json)。原始日志只保存在本工作树 ignored `work/t20/ui/`，记录逐件 SHA256。没有从本代理发布原件或更新 GitHub。

## 离线组合脚本准备

入口：[spec78-combination.mjs](https://github.com/Yukk1No/kinshoko/blob/3857dd8f/e2e/spec78-combination.mjs)。本阶段没有构建或启动程序。当前已新增 `spec78-combination-original.mjs`。入口仍在启动驱动前要求真实构建包含已审查的 T17 来源，并绑定本轮观察器／像素工具 SHA。最终 T17 尚未合入本工作树；原生阶段未执行。

- `fixture` 与 `preflight` 生成本轮独立 v16 A/B、位置及透明度原图、13MB 封印样本、144张瀑布流样本。Eagle 输入复用 T14 的实际像素及 metadata 结构，保留源脚本 SHA。冻结记录绑定实际源码文件、dist、隔离配置、EXE、驱动、未使用的输入及两种 KnownFolder 路径。
- `workflow` 在同一会话连续操作 A/B：登记与迁移、按来源 AND／去重、独立整理、明确 B 来源的钉图／组／复制、导出与再导入、输入后真实 catalog 变更触发监视器，以及任务提交目标与当前库／查找范围／下次保存目标分离。
- `eagle` 在同一 A/B 会话复用正式向导：永久删除后默认跳过、仅本次允许、回收站重复项保持删除状态，以及同一 Eagle 项的新内容版本可导入。只改本轮已核 SHA 的 Eagle 输入，不启动旧 T14 全流程。
- `sealed` 使用本次真实回执的只读 capability，核对 Channel 分块与撤销、已解码和待读取内容重新遮蔽。全局安全模式保持开启。
- `backup` 在同一会话操作两类备份和恢复。资料库恢复保留当前程序选择。程序设置默认替换，保留逐图整理、原件与设备登记。原图 SHA 与恢复 provenance 使用同轮实际输入和新 ID。
- `lifecycle` 另记正常托盘退出／重启、真实 B 目录断开／重新连接、最后 Adult 登记注销及空白环境恢复。Adult 盘点只读同轮 owned SQLite 的 rating/manual/auto 元数据，不关闭全局模式，不复写有效分级规则。
- 最终界面阶段检查真实运行时能力、实际诊断内容及完整手动安装包说明。诊断成功不清除独立色彩门槛。原型同样本同视口、正式 NSIS 干净安装和旧→新升级仍须单独执行。

驱动仅把失败 HTTP 状态当作协议错误。HTTP200 的业务 `status/error` 原样返回并记录。清理按精确 EXE、profile、驱动 PID／创建时间和端口核对；查询或终止失败则保持失败状态。只有确认相关进程及4630/4631全部释放，才恢复本测试 identifier 的原配置。空白环境的进程身份也纳入最终释放检查。正式 Kinshoko 配置、HKCU Run 与 T19 已有设置没有改动。

本轮9模块语法、入口导入和输入预检通过。5项驱动辅助检查只验证元数据 HTTP 和 PowerShell AST。12项输入检查只验证合成字节／解码／像素和只读旧数据库。它们不计正式程序验收。两种 KnownFolder 路径逐一记录：T20 当时两视图均无设置；T19 两视图均为247字节、SHA `c570d9186a9ed586bf382e9996d9807178641dd9aff6494bbb059f42fb7d916c`。首次建目录后 canonical 路径可能变化，后续记录真实 before/during/after。

最小派生记录：[combination-preparation.json](../evidence/spec78-t20/combination-preparation.json)。旧输入和旧检查原件继续保留。最终阶段必须重新冻结 clean commit/tree；本阶段没有 native plan 或桌面授权。

## 固定 ef77 审查后的脚本修正

固定审查来源 `ef77b07e2dedf5c3f038324204776935148de48b` 和旧原件保留。新增修正由 [combination-corrections.json](../evidence/spec78-t20/combination-corrections.json) 单独记录。

- 钉图关闭进入实际 WebDriver pin handle，在该窗口按 Esc。确认该 handle 销毁后才返回主窗口。不放宽正式命令的当前窗口权限。
- 驱动启动后立即记录初始 PID、EXE、创建时间和端口。正常退出与失败清理共用逐实例重新查询／终止逻辑。查询失败仍为失败，不使用未经复核的 taskkill 进程树。
- 保留原有分块撤销谓词。另要求关闭、同值安全模式、程序设置替换和当前库切换成功返回后，内容 chunk 和字节均为0。实际 Channel 返回边界尚未执行。
- 新夹具直接读取本构建的内置默认名称，将 B 的旧 `parted_hair` 名称设为“分缝发型”。正式迁移必须实际出现该相等来源，并保存明确偏好。没有可条件跳过的成功分支。之后更新默认表的保护仍由核心公开接口测试单独证明，不声称本轮 native 已更新默认表。
- 源码清单加入 `data/` 和 `.cargo/`。两份内置 JSON 是真实 `include_str!` 编译输入。
- v2 构建冻结和 native plan 必须带实际构建回执。旧的源码准备快照、路径和各自 hash 不能代替该回执。

本次13项辅助检查通过。它们覆盖9模块语法／安全导入、本地模拟 WebDriver 的 pin handle／Esc／销毁流程、元数据 HTTP、三段 PowerShell AST，以及无有效构建回执时拒绝计划。没有执行 CIM 查询、进程终止、构建或正式程序。新输入的13项字节／解码／像素和只读 SQLite 检查通过。前两次只读检查因脚本写错 `tag_external` 字段而失败；原脚本、退出状态和日志均保留。第三次按已读取的真实 `name` 列修正。该失败不属于产品结果。

## 尚未执行的构建与桌面门槛

最终 T17 合入和原图阶段收口后，根代理先指定 clean commit/tree、profile 和独立配置，再执行本树的显式 `--build <build-input.json>`。输入只包含 `configPath`、新的 owned `work` 路径和明确的 `profile`（`debug` 或 `release`）。此动作依次实际运行本地 Vite CLI 和 Tauri `build --no-bundle --target <actual-Rust-host> --config <exact-config>`，记录命令、cwd、jobs=2／本树 target、退出状态和原始 stdout／stderr。构建动作不会由 import、freeze、plan 或 run 自动触发。

回执必须记录前端构建前、前端构建后、native 构建前、native 构建后的实际源码文件；包含 data/.cargo。所有源码和隔离 config 必须一致。前端产出的 dist 必须与 native 构建前后相同。记录 T20 与已有 T19 的 requested／resolved KnownFolder 字节状态。失败回执保留，不能生成可运行计划。

构建成功后把实际 `kinshoko.exe` 和邻接全部 DLL 复制到该新轮的 `frozen-runtime/`。DirectML.dll 必须存在。每份源文件和冻结文件记录实际字节及 SHA，采用不覆盖复制。独立冻结目录允许离开 target；它必须仍在本树 owned work/e2e 内。v2 freeze、plan 和 run 均重新验证这些冻结文件，拒绝缺失、变化或未登记的邻接文件。

`--freeze <config> <new-freeze> <successful-build-receipt>` 才能生成构建冻结。`--plan` 只允许实际回执中的冻结 EXE。之后只改 harness 时必须明确记录允许的 commit 差异，产品文件、config、dist 和冻结 runtime 仍须一致。完整原图模块存在、未使用的新夹具、root 新的独占桌面 grant、KnownFolder 双路径及实际进程／端口前态都通过后，才允许 `--run`。

原型对照仍须从本轮正式程序的实际 A 范围卡片／顺序和已核 SHA 的同样本生成输入，使用认可原型 `bd8aea44c4a311571ee3c07382cb7755f87f3153`、同 CSS viewport／DPR／字体，并另记聚合入口的有意差异。没有运行原型或读取屏幕。

NSIS 仍须另做实际 release 构建、干净安装和旧→新升级。不能把 debug 包计为 release。可复用 T19 实际0.1.0旧包（SHA `b1ee1339bbc0e9e2981d50f6519409aab81b73f3574504a857a6fd0afb2a8e91`），但必须明确它原本是 debug baseline。新包保留该隔离产品身份，单独记录命令／退出、实际 release hook 和 runtime、bare EXE／NSIS packaged EXE／安装后 EXE 的区别、PE版本及两路径设置前后。已有 T19 设置和正式 HKCU Run 必须先由 root 核对并保全。这些安装步骤尚未执行。
