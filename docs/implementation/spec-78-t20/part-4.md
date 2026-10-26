# 78 T20 — 最终组合验收（4/4）

[返回索引](../spec-78-t20.md)

## 视觉修正与完整复验（2026-10-11，本机 Win11）

最小派生记录：[redesign-final.json](../evidence/spec78-t20/redesign-final.json)。原始轮次与截图在 ignored `work/e2e/spec78-t20-final-fed5ca4/` 与根 `work/v1-handoff/follow-up-spec/t20-gui-review/redesign/`。

### 修正（各自单独提交）

- `0a2deb6` 设置行：原生下拉按最长选项定宽，“自动打标”的名称折成两行、描述被截断。名称不再换行；行内控件限宽 240 px，长选项省略。纯样式，用视觉夹具核对（名称一行、描述完整、下拉 233 px）。
- `6282acc` 编辑分组：每组一行（图标、名称、成员数），lucide 图标操作带提示，悬停或聚焦时出现；成员为可排序小标签；“新建分组”为明确按钮。删除改为先确认（AlertDialog，只有确认按钮为红色）。无障碍名称不变。RED→GREEN：`TagOrganize.test.tsx`（确认前不发送删除）。
- `52f62b7` 任务卡片：详情面板打开时，卡片栈停在面板左侧；有浮动多选条时抬到操作条上方。夹具测量：与面板、操作条都不重叠。
- `34d5ab1` 顶栏：条件标签在查找框内横向滚动，输入区与“精确查找”不换行；主区变窄时先收起图片大小，再收起张数。夹具测量（详情面板打开、两个条件）：“精确查找”高 29.6 px，单行。
- `c57d919` 侧栏回收站：非当前图库的目录里多出自己的“回收站”，与 README 的侧栏三段不符（属缺陷）。现在回收站只在底部出现一次：平时是当前图库的；从导入回执“去回收站”打开别的图库的回收站时，这一项跟随该图库。RED→GREEN：`WorkspacePane.test.tsx`。
- harness：`5be4e61` 去掉为避开卡片遮挡而关闭结果卡的步骤，并改用唯一的底部回收站；`fed5ca4` 让旧的共享分组脚本先确认删除。其余旧脚本按无障碍名称匹配，不受影响。

### 检查与构建

`fed5ca4`：fmt、strict Clippy、绑定无差异、Rust 721 通过／0 失败／12 忽略、tsc、前端 50 文件 355 项、43 个 e2e 模块 `node --check`、像素测试 4 例全部通过。显式 `--build` 的 EXE SHA256 `5631e22f…4a84`（102,005,760 B），隔离设置不变。开轮前在 `work/` 下做 SQLite 写入加目录改名，10/10 成功。

### 原生轮次 r21（新夹具，含空白环境）

退出 0，状态 `verified-combined-native-flow`：同一会话连续 259 项，主驱动合计 271 项（含正常托盘退出与重启、B 目录断开与重连），空白环境另 20 项；内容备份与两类恢复全部通过。精确进程与端口已释放，KnownFolder 已恢复。会话内原型检查点冻结 148 张 A 公开卡片，顺序与认可原型一致。回收站来源的框选复制仍按原图区域复制（`copy-allowed-from-trashed-source-original`），符合负责人决定（见上文）。

### 原型对照

r21 公开包、新镜像与新 Edge profile：8 项通过。返回后锚点偏移为正式 465.2 px、原型 466.8 px。

### 审阅截图

隔离构建 `fed5ca4` 重拍 20 张（新增 `05b-details-panel-with-card.png`：详情面板打开且有结果卡），原在根 `work/v1-handoff/follow-up-spec/t20-gui-review/redesign/`，下一节重拍后移到同级 `redesign-fed5ca4/`，`index.json` SHA256 `cc77277d…fab7`。可见像素中没有主机名、用户路径或邮箱；导入对话框的“来自”折叠列表在 DOM 中含本机路径，但没有展开显示。

### 未验证

- release NSIS、#99、Windows 10、人工视觉验收、物理 DPI 与笔输入。

## 详情面板标签与备注改版（2026-10-11，本机 Win11）

最小派生记录：[redesign-details.json](../evidence/spec78-t20/redesign-details.json)。原始轮次与截图在 ignored `work/e2e/spec78-t20-final-{abe2a38,fa00d08}/` 与根审阅目录。

### 改动

- `3c15559` 标签与备注（文案按 copy-map）：
  - 现有标签是小标签，带出处（人工添加、模型 0.92、Eagle）；“统一为”放进提示。
  - 悬停或用键盘聚焦时露出安静的图标操作：保留、改回自动、不要这个、别名。
  - 排除的标签单列一行“已排除”，划线，带“恢复”。
  - 加标签只有一个字段：类别（一般／作者／角色／作品）是字段内的紧凑下拉，后面是输入；打字后才出现“添加／排除／改回自动”。
  - 备注用改版字段样式；有未保存的改动才出现“保存”，有自己写的备注才能“用来源的”（退回来源备注需要在保存后仍可用）。
  - 原来的无障碍名称全部不变（添加标签、否决标签、清除标签决定、确认／否决／清除对“x”、撤销否决“x”、保存备注、退回来源备注、命名空间、标签名、库内标签、有效标签、已否决），测试未改即通过。
- `a67c721` 编辑分组的成员操作原用 `display:none` 收起，键盘无法聚焦；改为宽度收起、聚焦或悬停时展开（详情面板标签同样做法）。
- `fa00d08` 收起容器会裁掉焦点环：焦点环改画在按钮内侧；不可用的“用来源的”明显变淡。
- harness `abe2a38`：组合运行与旧 `source-actions.mjs` 按无障碍名称点“保存备注”“添加标签”（可见文字已改为“保存”“添加”）。

用视觉夹具核对：键盘聚焦能展开标签操作（60 px），打字后出现三项操作，改备注后出现“保存”。

### 检查与构建

`fa00d08`：fmt、strict Clippy、绑定无差异、Rust 721 通过／0 失败／12 忽略、tsc、前端 50 文件 355 项、43 个 e2e 模块 `node --check`、像素测试 4 例全部通过。显式 `--build` 的 EXE SHA256 `ba1e0829…56ba`。开轮前在 `work/` 下改名 10/10 成功。

### 原生轮次

- r22（`abe2a38`）与 r23（`fa00d08`，最终）都是 `verified-combined-native-flow`：同一会话连续 259 项，主驱动 271 项，空白环境 20 项；精确释放，KnownFolder 恢复；原型检查点 148 张，顺序一致。
- 原型对照（r23 公开包）：8 项通过，锚点偏移正式 465.2 px、原型 466.8 px。

### 审阅截图

隔离构建 `fa00d08` 重拍 21 张，在根 `work/v1-handoff/follow-up-spec/t20-gui-review/redesign/`（`index.json` SHA256 `be2318c6…b4de`）：
- `05b-details-panel-with-card.png`：详情面板打开且有结果卡。
- 新增 `05c-details-panel-tags-and-note.png`：有标签、已排除一项、备注已改未存。
- 前一套移到 `redesign-abe2a38/`；`abe2a38` 上第一次重拍因脚本在界面上加标签后选中被清空而中断，原件在 `redesign-abe2a38-failed-1/`。
- 可见像素中没有个人信息；“来自”折叠列表同前。

### 负责人已决定

- 选中保留（2026-10-11）：在详情面板编辑选中图的标签、备注或来源后，这张图保持选中，面板保持打开。原来工作区修订一变就清空选中（2026-10-08 起）；审阅修正一节改为修订变化时保留仍然存在的选中图，已删除或移出当前范围的自动去掉。05c 当时的标签是通过公开命令 `edit_tags` 预先加上的。

## release NSIS 干净安装与升级（2026-10-11，本机 Win11）

最小派生记录：[release-nsis-lifecycle.json](../evidence/spec78-t20/release-nsis-lifecycle.json)。构建日志、回执、轮次轨迹与截图只保存在 ignored `work/e2e/spec78-t20-release-{preflight-v1,nsis-*,lifecycle-r*}/`，按 SHA 引用；失败原件保持不变。

### 身份与前置核对

沿用 T19 隔离身份：产品名 `Kinshoko T19 Upgrade Probe`、identifier `dev.kinshoko.spec78t19upgrade`、程序名 `kinshoko-t19-upgrade`、currentUser 安装、`KINSHOKO_SKIP_AUTOSTART=1`。与正式产品（`Kinshoko`／`dev.kinshoko`）在 identifier、安装目录、Run 值名、两处 AppData 目录、卸载键和 `HKCU\Software\kinshoko` 子键上都不相同，没有冲突。

开轮前只读记录：正式 HKCU Run “Kinshoko”（64/32 视图的类型与值）、隔离 Run 值不存在、无隔离卸载登记、`HKCU\Software\kinshoko` 只有正式子键、无隔离快捷方式、T19 设置的两个 KnownFolder 别名都不存在、T20 别名状态、4630/4631 无监听、无相关进程。整个过程没有出现 UAC，也没有系统级更改。

### 构建（`855ca43`，release）

旧包仍是 T19 实际 0.1.0 NSIS（SHA `b1ee1339…8e91`，源码 `536cc43`）。它本是 debug 包，本节不把它算作 release。

新包 0.1.2 由 `e2e/spec78-combination-installer.mjs --build` 实际构建：
- 工具链：rustc 1.95.0，host `x86_64-pc-windows-msvc`，tauri-cli 2.12.1。
- 前置检查：继承环境中 `CARGO_BUILD_TARGET` 与 `TAURI_CONFIG` 都不存在。
- 三条命令均退出 0：`vite build`、`tauri build --no-bundle --target … --config <隔离配置>`、`tauri bundle --bundles nsis …`。
- 冻结 SHA256：
  - bare EXE `76fd10ba…`
  - NSIS 编译期包内 EXE `a6d0fe77…`：由 `!system` 回调在 makensis 编译时实际观察，与 bare 只差标记的 3 字节，偏移 59690648。
  - 安装包 `6f18315a…`
  - release `DirectML.dll` `9c9e6d82…2da1`

`--check-build` 独立复核通过。每个 harness 提交都属于构建来源，所以每轮都重新构建。产品输入与 dist 都相同，bare EXE 在各次重建之间差 24 字节（PE 头时间戳一类，属链接器不确定性，未深究）。

### 生命周期 r5（`855ca43`）

退出 0，状态 `actual-clean-and-old-to-new-lifecycles-observed`，共 26 项断言。每次安装前，RestartManager 都没有占用者。

- 干净安装：先在空环境 `/S /D=` 安装 0.1.2，退出 0。
  - 安装后 EXE 等于编译期包内 EXE，PE 版本 0.1.2，release DirectML 已就位，卸载登记属于本目标。
  - 用正式界面建库并导入，设置非默认选项、快捷键、钉图和参考组。诊断页显示运行环境；更新页为手动更新，`install_update` 在命令边界被拒。
  - 经真实托盘“退出”正常退出（退出码 0）。重启后状态完整恢复，再次正常退出，最后用其卸载程序 `/S _?=` 卸载。
- 升级：
  1. 安装实际 0.1.0（PE 0.1.0，包内 EXE `8dfd1074…`）。
  2. 建库、导入，保存设置、钉图和参考组。
  3. 从托盘正常退出。
  4. 不卸载，直接在原目录运行 0.1.2 `/S /UPDATE /D=`，退出 0。
  5. 安装后 EXE 等于新包内 EXE，PE 0.1.2，release runtime 就位。登记、设置、快捷键、参考组、钉图和 safe mode 全部保留，原图可解析，更新页为手动更新。
  6. 正常退出后卸载。

### 恢复

- 正式 Run 值在每次登记观察中都与开轮前一致。
- 卸载登记与 `HKCU\Software\kinshoko\Kinshoko T19 Upgrade Probe` 产品键都恢复为不存在。静默卸载会留下这个产品键（只含安装目录），harness 只删除记录本阶段目录的这个键。
- T19 设置文件的两个别名都恢复为不存在。程序经 KnownFolder 新建的 `%APPDATA%`／`%LOCALAPPDATA%` 下同名目录，在开轮前不存在，结束时为空，已删除。
- 用同一前置脚本独立复核：全部与开轮前记录一致。
- 只结束本轮自己启动的进程（精确 PID／路径／创建时间）。

### 失败轮次（均为 harness，未改产品）

r1–r4 均保留原件。每轮失败后，都先用该目标自己的卸载程序清理，再按前置记录核对复原，然后开下一轮。

| 轮次 | 来源 | 失败原因 | 修正 |
|---|---|---|---|
| r1 | `4c53636` | 卸载登记的 `InstallLocation` 带引号，被精确目标检查拒绝 | `507fe79` 只接受一对外围引号 |
| r2 | `507fe79` | 未确认的后代进程被拒，但没有说明是哪个进程 | `7327557` 在失败信息中写出身份 |
| r3 | `7327557` | WebView2 启动了 `System32\conhost.exe` | `d3490dd` 按精确系统路径、经同一谱系接受 |
| r4 | `d3490dd` | 原位卸载程序在第一次进程查询前就已退出（退出码 0），恢复被跳过 | `855ca43` 只在退出后的查询中该 PID 已消失、且没有以它为父并晚于启动时刻的进程时才接受 |

`507fe79` 还加入产品键观察与清理。`d3490dd`／`855ca43` 还加入两个身份目录的恢复。所有断言都没有放宽。

### 未验证

- 交互安装向导与双击安装。
- 旧基线本身是 debug 包。
- #99 签名自动更新。
- Windows 10。
- 无开发环境的干净机器。
- 人工视觉验收、物理 DPI 与笔输入。
