# #78 T20 — 最终组合验收

本单对应 #98、故事52。前几节按时间记录准备过程，其中“未执行”“尚未”只描述当时的状态。现状：两库组合原生轮次（r21–r23 与审阅修正后的新一轮）、原型对照、release NSIS 干净安装与升级都已执行，见后面各节；审阅修正一节另加了原生窗口控件。Windows 10、#99 签名自动更新、人工视觉验收、物理 DPI 与笔输入仍未验证。前置 #42／PR71、原始规格和既有验收状态保持原样。

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

最小派生记录：[ui-preparation.json](evidence/spec78-t20/ui-preparation.json)。原始日志只保存在本工作树 ignored `work/t20/ui/`，记录逐件 SHA256。没有从本代理发布原件或更新 GitHub。

## 离线组合脚本准备

入口：[spec78-combination.mjs](../../e2e/spec78-combination.mjs)。本阶段没有构建或启动程序。当前已新增 `spec78-combination-original.mjs`。入口仍在启动驱动前要求真实构建包含已审查的 T17 来源，并绑定本轮观察器／像素工具 SHA。最终 T17 尚未合入本工作树；原生阶段未执行。

- `fixture` 与 `preflight` 生成本轮独立 v16 A/B、位置及透明度原图、13MB 封印样本、144张瀑布流样本。Eagle 输入复用 T14 的实际像素及 metadata 结构，保留源脚本 SHA。冻结记录绑定实际源码文件、dist、隔离配置、EXE、驱动、未使用的输入及两种 KnownFolder 路径。
- `workflow` 在同一会话连续操作 A/B：登记与迁移、按来源 AND／去重、独立整理、明确 B 来源的钉图／组／复制、导出与再导入、输入后真实 catalog 变更触发监视器，以及任务提交目标与当前库／查找范围／下次保存目标分离。
- `eagle` 在同一 A/B 会话复用正式向导：永久删除后默认跳过、仅本次允许、回收站重复项保持删除状态，以及同一 Eagle 项的新内容版本可导入。只改本轮已核 SHA 的 Eagle 输入，不启动旧 T14 全流程。
- `sealed` 使用本次真实回执的只读 capability，核对 Channel 分块与撤销、已解码和待读取内容重新遮蔽。全局安全模式保持开启。
- `backup` 在同一会话操作两类备份和恢复。资料库恢复保留当前程序选择。程序设置默认替换，保留逐图整理、原件与设备登记。原图 SHA 与恢复 provenance 使用同轮实际输入和新 ID。
- `lifecycle` 另记正常托盘退出／重启、真实 B 目录断开／重新连接、最后 Adult 登记注销及空白环境恢复。Adult 盘点只读同轮 owned SQLite 的 rating/manual/auto 元数据，不关闭全局模式，不复写有效分级规则。
- 最终界面阶段检查真实运行时能力、实际诊断内容及完整手动安装包说明。诊断成功不清除独立色彩门槛。原型同样本同视口、正式 NSIS 干净安装和旧→新升级仍须单独执行。

驱动仅把失败 HTTP 状态当作协议错误。HTTP200 的业务 `status/error` 原样返回并记录。清理按精确 EXE、profile、驱动 PID／创建时间和端口核对；查询或终止失败则保持失败状态。只有确认相关进程及4630/4631全部释放，才恢复本测试 identifier 的原配置。空白环境的进程身份也纳入最终释放检查。正式 Kinshoko 配置、HKCU Run 与 T19 已有设置没有改动。

本轮9模块语法、入口导入和输入预检通过。5项驱动辅助检查只验证元数据 HTTP 和 PowerShell AST。12项输入检查只验证合成字节／解码／像素和只读旧数据库。它们不计正式程序验收。两种 KnownFolder 路径逐一记录：T20 当时两视图均无设置；T19 两视图均为247字节、SHA `c570d9186a9ed586bf382e9996d9807178641dd9aff6494bbb059f42fb7d916c`。首次建目录后 canonical 路径可能变化，后续记录真实 before/during/after。

最小派生记录：[combination-preparation.json](evidence/spec78-t20/combination-preparation.json)。旧输入和旧检查原件继续保留。最终阶段必须重新冻结 clean commit/tree；本阶段没有 native plan 或桌面授权。

## 固定 ef77 审查后的脚本修正

固定审查来源 `ef77b07e2dedf5c3f038324204776935148de48b` 和旧原件保留。新增修正由 [combination-corrections.json](evidence/spec78-t20/combination-corrections.json) 单独记录。

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

## 原图组合阶段的新增离线准备

新增 [spec78-combination-original.mjs](../../e2e/spec78-combination-original.mjs) 和纯文件 [spec78-combination-original-pixels.py](../../e2e/spec78-combination-original-pixels.py)。本段是待运行的脚本行为。没有启动程序、原型、CIM、编译器或构建，也没有读取屏幕或剪贴板。

脚本直接读取固定 T17 `1d188e52a9639319dbaf90de9fe46a9a6fcea9b3` 的公开 capture、PinFrame 和像素工具契约。没有 import 旧顶层 runner。当前部分产品 `b856` 即使已加入该脚本，也会在启动前被祖先门槛拒绝。最终来源仍须由根代理合入后重新冻结。原生观察器由真实集成带入，不预先拷贝或修改冻结 T17 输入。

同一真实 A/B 会话内，脚本计划核对图片墙、虚拟返回与真实侧栏重排、适应窗口的 A 查看器，以及明确 B 来源的局部钉图。钉图实际经过水平翻转、顺时针四分之一圈和缩放。选区由真实 overlay 的 pointer 拖动与实际物理选区读取；截图必须显示完整尺寸和三个操作按钮。复制后直接只读实际 OS 剪贴板，再将完整 RGBA、透明度和尺寸与原图区域比较。原图动作不得增加普通截图历史。新钉图须保留明确 provider／image、原图 crop 和变换。

两类失效检查保留同一会话：从实际 B pin WebView 调用其有权限的 `close_pin`，确认该窗口销毁而冻结选区仍存在；另将明确 A 来源（图片，不是图库）移入回收站，确认 byte-identical B 仍可用。关闭钉图的完成动作须返回真实业务错误，剪贴板 RGBA／尺寸和普通历史保持原样；回收站来源一项后来由负责人决定为允许复制（见“未验证与待定”）。A 之后通过明确恢复动作还原。没有通过 main 关闭 pin，也没有放宽正式 ACL。

纯文件 oracle 用精确分数反解几何边缘，读取本轮已导入原图的真实 RGBA。它不调用 ImageGrab 或 Win32。原生观察器只会在根代理新 grant 的正式阶段执行。钉图手工 rAF 动画还必须等实际 canvas BCR×DPR 与 native content 完全对齐，不能只看 `getAnimations()`。画布若禁止 JS 读回，会保留该状态；实际冻结选区仍须显示非占位的图片细节。不能把未执行的像素比较称为原图质量通过。

构建门槛另要求 `CARGO_BUILD_TARGET` 与 `TAURI_CONFIG` 两个变量均不存在，空值也拒绝。实际构建动作才运行并保留 `rustc -vV`、`cargo -vV`、`rustc --print sysroot` 和明确 compiler 的版本命令／退出／原始日志。选用的 compiler SHA、实际 Windows MSVC host、显式 `--target`、继承环境及 jobs=2 均记录。产物从 `<own-target>/<actual-host>/<profile>` 冻结，不能从继承 target 猜路径。失败的工具链观察也保留在失败回执。

本轮离线检查原件在 ignored `work/e2e/spec78-t20-original-preparation-1791508193093/`。前四个检查器轮次分别保留：缺 Babel parser；错误假设 TypeScript 7 提供旧 API；错误 EOF 名称造成约30秒 Node heap OOM／退出134；有界扫描后发现当前未集成树缺 T17 原生观察器。它们属于检查器或未满足的集成前提，不属于正式程序结果。根代理已核对 OOM 负载没有与 T17 fullwall 轮重叠。诊断独占期间已暂停扫描和检查。根代理确认释放后，最终有界8项辅助检查通过；纯文件7项检查通过，含16种翻转／四分之一圈组合。最终原件另存在 `work/e2e/spec78-t20-original-final-checks-1791509076541/`。嵌入的浏览器脚本只做语法编译，没有执行。当前缺失观察器仍按未满足记录；T17 合入后必须再核真实依赖。

最小派生记录：[combination-original-preparation.json](evidence/spec78-t20/combination-original-preparation.json)。全部原始输入、失败和最终检查分别绑定实际字节与 SHA。不能累计为正式组合验收。

原型输入采用探索记录 `prototype-final-packet-notes.md`（仓库外 SHA `450ce2c43ffa10b78edbbce25a9586ef21a633b364e573100830a0da409580e3`）。正式包使用本轮 public A 全页顺序、逐来源真实 collectedAt 和 exact 原图；不能继承旧43张、编日期或取子集凑一致。认可原型的 date DESC stable sort 必须实际保持同序。旧 `.local` 全目录和既有 browser profile 均须保留。该方案尚未执行。

## 最终验收的范围（已执行，见后文）

T17 已合入后才做最终构建。主操作使用同一最终 EXE、同一会话和两份独立真实资料库，覆盖迁移、查找、来源整理、保存目标、框选、任务限定展开和两类恢复。重启、空白环境、干净安装和实际旧版升级分别记录生命周期，不累计旧脚本子项冒充组合结果。这些都已执行：组合原生轮次见“最终组合运行”及之后各节，干净安装与升级见“release NSIS 干净安装与升级”。

Windows10没有可用设备或虚拟机。负责人明确接受其未验证状态。实际Windows11、物理显示、输入和开发者真机结果只按执行事实记录。旧11项CI颜色失败和前置未完成验收保持原状态。外部签名自动更新仍归 #99，不由本单代替。

## 同一会话中的原型对照检查点

新增 `e2e/spec78-combination-prototype.mjs`。正式工作流将检查点放在固定保存目标验证之后、Eagle 重导之前，仍使用同一最终构建、A/B 会话且早于生命周期切换。固定工单与计划第10步没有要求在全部 Eagle 动作之后才取包。该位置不是对后续 Eagle 当前状态的描述。

正式阶段将用真实控件选择 A 全部范围并清空条件，保留完整 public 分页、同一 revision/total、实际 N、逐个明确 A 来源 inspection、真实 collectedAt、原图 SHA/尺寸和实际 viewport/DPR/字体。认可原型仍按真实日期排序；只有排序实际保持 public 顺序，才能准备同序输入。兼容性当前未验证。不能编日期、静默重排、取子集，或套用旧43张。

输入准备采用新的 accepted-code 镜像，逐件复制认可代码、原字节 PNG 和四字体；配置源码不修改。镜像通过明确 junction 使用既有离线 prototype 依赖，是否成功解析仍须实际检查。旧 `.local` 整个目录只读盘点，前后必须相同；既有浏览器 profile 不复用。此阶段尚未实际创建镜像或运行浏览器。

模块另准备同卡片打开／适应／返回焦点、Enter/Escape、侧栏往返和窗口宽度往返的实际对照动作。实际 viewport 必须精确相等；每个字体 family/weight 都须成功加载。它只接收根代理另行授予且拥有的浏览器会话，不启动服务器或驱动。浏览器／服务器进程归属与释放 wrapper 尚待完成。原型的固定目录、空标签、Unknown 显示适配和页内钉图不能替代正式业务结论。

本次纯包 RED 为6成功／2失败，分别缺少 A 显示来源和安全模式下 Adult 输入拒绝。收口后8项成功；单文件语法成功。原件分别保存在 `work/e2e/spec78-t20-prototype-preparation-1791511114275/`，未覆盖旧轮。它们只使用合成公开响应，不是正式程序或原型结果。最小派生记录为 [combination-prototype-preparation.json](evidence/spec78-t20/combination-prototype-preparation.json)。实际正式包、原型对照、安装和完整 T20 均未验证。


## 浏览器与 release NSIS 的离线准备候选

固定 `80d5764` 的独立只读审查只有一项 P2：`checker` 寻找认可原型中不存在的“背景：棋盘格”。本候选只把映射改成认可原型实际“棋盘”，四种背景都与实际 `GROUNDS` 对齐。认可原型代码未改。审查原件 SHA 为 `2f13b7faeebf377e1cd2053e5256ed7b97e29f3d83db54724007b3cd045d11e8`；80d 的检查与冻结原件保留。

新增 `e2e/spec78-combination-prototype-browser.mjs`。未来明确执行 `--run` 前必须有根代理对精确计划的新独占 grant。它计划使用实际 Node/Vite CLI、完整认可镜像配置、新的独立 headless Edge profile 与驱动。同样本、完整 N、viewport/DPR/字体和正式检查点仍由已有原型模块验证。这个 wrapper 不复用用户 profile。它保留最初 spawn 的 PID/path/creation，核对监听端口所有者、参数唯一性、已知子进程路径和创建时间。身份或查询失败会保留未释放状态；只有应用会话、服务器、驱动、profile 进程和两个实际端口均为空才能记录释放。CIM 全结果只用于内存筛选；不把无关用户进程命令写入回执。

新增 `e2e/spec78-combination-installer.mjs`。当前只准备同一 T19 隔离产品名／程序名／identifier 的 0.1.2 release 包。旧基线必须是实际 0.1.0 NSIS、原配置及原构建记录，明确保留其 debug 属性。本候选不会把旧 debug 验证变成 release 通过。未来单独允许构建后，先保存实际 Rust host/compiler/env，要求继承 `CARGO_BUILD_TARGET` 与 `TAURI_CONFIG` 都不存在；再记录 frontend、release native、NSIS bundle 三个命令、退出和原始日志。整个阶段核对真实 data/.cargo/source/dist/config，以及 native 前已存在的主 hook 和 bundle 前生成的实际 runtime include。

NSIS 编译期 helper 计划直接观测已被实际 bundler 修改的 EXE，将它与此构建裸 EXE 的精确三字节 marker 操作比较，然后独立冻结实际包内 EXE、安装包和全部 runtime DLL。它不把推导出来的 marker 字节称为提取的安装产物。真实 NSIS 语法、构建、payload、安装及 DLL 装载尚未执行。

本候选有界纯检查：browser 身份第一轮8成功／1失败，因已被独立识别的 child 创建时间没有与已识别 parent 比较；补相同身份层的时序门槛后9成功。原型 public packet 8成功，installer 准备9成功，helper 5成功。21段浏览器程序只做语法编译、0执行；两段 PowerShell 观察／终止程序只被解析为 AST、0执行。旧8／1失败原件、旧 installer 版本边界 RED 和80d旧轮均保留。合成 `.exe` 文件只是 marker 测试数据，没有被执行。

原件在 `work/e2e/spec78-t20-offline-wrapper-preparation-v1/`，最小派生索引为 [combination-browser-installer-preparation.json](evidence/spec78-t20/combination-browser-installer-preparation.json)。本段为 additive T20 准备，不修改前置进度。真实 clean install 和 actual0.1.0 创建／保存→托盘正常退出→0.1.2 release `/UPDATE` 生命周期 runner 继续准备；两个 KnownFolder aliases 的既有 T19 字节、正式 Kinshoko Run 值和隔离安装归属必须重新核对并保全。浏览器、本机、安装、硬件和完整 T20 仍未验证。

## 最终组合运行（2026-10-09/10，本机 Win11）

本节为实际执行结果。最小派生记录：[final-combination.json](evidence/spec78-t20/final-combination.json)。原始轮次、构建回执、命令轨迹和截图只保存在本工作树 ignored `work/e2e/spec78-t20-final-*/`，每轮失败原件保持不变。

### 来源与构建

- 合入集成 `4ae84740a6b6e33423cfc93a43c393eee99ecb0c`（含 T15/T17/T18），无冲突。
- 最终产品提交 `7f2f852c28934293dd29c8a7ba5e9936d5f7541e`，tree `9e90e88562a35d3718a18ffec82fe682b299a358`。显式 `--build` 实际执行 Vite 与 `tauri build --debug --no-bundle --features tauri/custom-protocol --target x86_64-pc-windows-msvc`，jobs=2、本树 target。冻结 EXE SHA256 `c45a80a4199678a9162e9cec5f9a6bea1367f01a04abd5480060362d5d208c87`（101,864,448 B），DirectML.dll `9c9e6d82…2da1`。隔离 identifier `dev.kinshoko.spec78t20test`，`KINSHOKO_SKIP_AUTOSTART=1`，独立数据、WebView profile 与端口 4630/4631。
- 之后的 `11e9110` 只改 e2e，按计划记录为 harness-only 观察来源。

### 自动检查（`11e9110`，产品输入与 `7f2f852` 相同）

fmt 通过；workspace 全目标 strict Clippy 通过；绑定重新生成后无差异（core 711 通过）；Rust workspace 721 通过／0 失败／12 忽略；tsc 通过；前端 42 文件 294 项通过；43 个 e2e 模块 `node --check` 通过。合入后首轮 `af0eaf8` 的前端为 291/292：`TagOrganize` 在首次分组刷新期间点击了仍为 disabled 的“新建标签分组”（原始失败 DOM 可见 `disabled`）。只把测试前提改为等待该按钮可用，原失败保留。

### 产品修正（均先有公开行为 RED）

- `src/wall/Wall.tsx:200`：再次选中同一范围会传入值相同的新对象。清空卡片的 effect 按对象身份触发，重新浏览的 effect 不触发，图片墙停在“无卡片、无数量、无错误”。r5/r6 实际复现；诊断 diag3 观察 60 秒仍为空，同时公开 browse 约 50 ms 返回 1 张。改为按范围值触发。公开组件 RED→GREEN：`Wall.workspace.test.tsx`。
- `src/library/LibraryPicker.tsx:34`：内容恢复在空白环境中登记的新资料库已出现在工作区侧栏，但“当前资料库”只有“尚未打开”，需手动“刷新登记”（r10 实际复现）。改为在工作区资料库集合变化时重读登记。RED→GREEN：`LibraryPicker.test.tsx`。

### 计划内界面观察的复核

- 参考组侧栏：最终来源截图中长组名、长导出路径换行，卡片按钮可读，使用满高，无水平滚动。
- 来源编辑：只在跨库复制后的重新校验期间短暂显示“正在读取该来源…”，随后完成加载。没有复现持续加载，未改产品；工作流改为等待加载完成后截图。
- 标签选择器迟到事件：正式程序中输入后真实目录变更触发的通知没有关闭选择器，焦点与输入保留，回车成功加入成员。
- 更新面板：显示“当前使用安装包手动更新。”及手动安装步骤。

### 原生轮次

r1–r10 均失败并保留原件；每次修正后用新夹具重新完整运行，没有累计子项。失败原因依次为：绝对 `frontendDist` 被 Tauri 解析为 URL（r1）；复制后比较了非人工来源（r2）；2000 项导入等待上限过短（r3）；WebDriver 改窗口尺寸对 Tauri WebView2 无效，改为对本轮主 HWND 调 `SetWindowPos`（r4）；上述图片墙缺陷（r5/r6）；登记 ID 字段读错（r7）；回收站来源截图策略（r8，见下）；对非当前库调用 `image` 命令（r9）；上述资料库选择缺陷（r10）。另修正：Windows PowerShell 把 JSON 数组整体当作一个对象，导致精确 PID 终止失败（r1 清理只结束本轮自有 PID 后手工确认释放）；T20 专用托盘退出助手；KnownFolder 在删除后被包重定向时仅接受“仍不存在”的情形；Eagle 选择前等待修订稳定；分页遇到快照过期从头重读。

r11（产品 `7f2f852`，2026-10-09T21:45:10–21:51:37Z）退出 0，状态 `verified-combined-native-flow`：同一会话 254 项连续断言，主驱动合计 266 项（含正常托盘退出／重启和 B 目录断开／重连），空白环境另 18 项；精确进程与端口释放已确认，KnownFolder 恢复。会话内原型检查点冻结 148 张 A 公开卡片，顺序与认可原型一致。

### 原型对照

认可原型 `bd8aea44c4a311571ee3c07382cb7755f87f3153`，新镜像与新 headless Edge 155 profile，同一份包、1280×800、DPR 1.25：8 项断言通过，148 张。首次尝试在 DPR 1.25 下视口在 1282×800 与 1280×802 间振荡而失败（harness），原件保留；改为逐维调整后通过。单击／回车返回后的卡片锚点偏移实际不同：正式程序 386 px，原型 466.8 px，按差异记录。

### 未验证与待定

- 回收站来源（负责人已决定，2026-10-11）：把框选所冻结的那张图（A 库里的图片来源，不是整个图库）移入回收站，不需要让已冻结的框选来源失效，这个边角情况不做特殊处理，前提是复制不报错、不崩溃。实际行为符合：框选冻结在 A 的这张图上，随后它移入回收站，复制仍成功，结果与 A 原图区域逐像素一致，普通截图历史不变。保留此行为；`spec78-combination-original.mjs` 的 `trashedSourceCopy` 现在断言“允许”，不再两种结果都接受。
- 已修（#98）：复制、导入等连续变更后常驻的“浏览结果已变化，请从头重新浏览／知道了”横幅。根因：后端 `stable()`（`src-tauri/src/library/workspace.rs:43`）对任何工作区读取在读取前后修订不同时都返回 `CursorExpired`，而标签分组、目录（自带 3 次重试在连续变更中耗尽）、条件解析等非分页读取把它经 `onError` 直接写进 `App` 的常驻横幅；保存位置选择器同样把它显示为提示。同修订的变更通知又被略过，没有补读，横幅只能手动关闭。改为：`App` 的 `onError` 与条件解析把它当作重读信号（与变更通知相同地递增 `reloadKey`／`vocabularyKey`），保存位置按新修订重读；其他失败照旧显示横幅。图片墙分页遇到快照过期仍由图片墙自行从头重读，多次仍不稳定时在墙内提示，不变。RED→GREEN：`src/App.workspace-revision-race.test.tsx`。启动首次 `workspace_status` 遇到 `CursorExpired` 仍直接显示（测试中被启动时安全模式确认掩盖，未复现，未改）。
- release NSIS 干净安装与 0.1.0→0.1.2 升级：已执行，见下文“release NSIS 干净安装与升级”。#99 签名自动更新、Windows 10、人工视觉验收、物理 DPI 与笔输入均未验证。旧 11 项 CI 色彩失败与前置未完成验收保持原状态。
- 本地审阅截图在 root `work/v1-handoff/follow-up-spec/t20-gui-review/`，含本机路径，不直接公开。

## 界面改版合入后的复验（2026-10-10，本机 Win11）

最小派生记录：[redesign-combination.json](evidence/spec78-t20/redesign-combination.json)。原始轮次、构建回执、探针与截图只保存在本工作树 ignored `work/e2e/spec78-t20-final-{aba127c,2f68bf9,99194e1,5f0d0f0,55b37c5}/` 与 `work/t20/`，每轮失败原件保持不变。

### 来源

改版合入 `0e37372`（B）、`1fc0ed9`（C），接线修正 `6065109`。之后本轮提交：harness `3d55b32`、`aba127c`、`ca2c8bd`、`d1b0244`、`5f0d0f0`、`d1a9ee0`；产品 `2f68bf9`、`99194e1`、`663b3bc`、`55b37c5`。最终产品提交 `55b37c50020c00c1dadfe5f0136eda6dd4af5f6b`，显式 `--build`（debug、内嵌前端、无包），EXE SHA256 `3e04e6fe…68bf`；隔离 identifier、`KINSHOKO_SKIP_AUTOSTART=1`、独立数据／profile／端口不变。

### harness 适配（未删减断言）

按角色与无障碍名称找控件：设置的七个分页与“标签”分段、侧栏标题的图库菜单（同名库按根目录区分）、“确认旧名称”向导、先选文件后弹对话框的导入与右下角卡片、详情面板中的来源整理、参考组卡片“…”菜单、浮动多选条、侧栏底部的当前图库回收站、设置 › 备份 › 图库／偏好设置、诊断 › 运行环境与更新 › 查看步骤、查看器与框选 dock（名称形如“复制，Ctrl C”，顺序为复制／钉住／取消）。改版改写的文案按现文匹配。

- 导入进行中无法再打开导入对话框；“下次保存 A”改为在任务运行期间真实执行一次“导入参考组包”到 A／同名目录，并断言该次保存落在 A。
- 右下角结果卡遮住详情面板底部按钮；用到其文字与链接后像用户一样关闭。
- 封印预览是模态 `<dialog>`，背后的图库菜单不可点。与旧 harness 用 JS 改 select 相同，用合成事件切换当前图库，保留“重新遮蔽／需再次同意”断言。
- `viewer.mjs`、`spec78-frontend.mjs` 的点击按无障碍名称匹配，`save-destination.mjs` 只改“收藏”。这三个独立脚本的其余旧界面步骤未改，也未在本机运行。

### 产品修正（均先有公开行为 RED）

- `src/library/ImportBar.tsx`：三个导入对话框只在打开时渲染 Popup。关闭时 Popup 卸下，Base UI 等不到退出动画，透明遮罩留在整个窗口上，第一次导入后所有点按失效（r12）。改为 Popup 常驻，只让内容随状态出现。RED→GREEN：`ImportBar.test.tsx`。
- `src/library/ImportMenu.tsx`：主窗口只按当前图库接收导入事件，导入到别的图库后它记下的“进行中”不会结束。回执全部关闭后菜单退回这份旧状态，出现“正在导入 0 / 0”且导入按钮一直忙（r14）。已关闭回执的任务不再借它复活。RED→GREEN：`ImportMenu.test.tsx`。
- 同文件：回执来自工作区快照，导入发布变更时可能 CursorExpired，轮询把它写成卡片上常驻的“浏览结果已变化”（r16）。按 #98 的做法当作重读信号。RED→GREEN：`ImportMenu.test.tsx`。
- `src/library/WorkspaceSourceEditor.tsx`：钉住、加入组、复制自身的变更使来源重读，回复属于旧 key，忙状态不清，按钮与组名长期禁用（r18；改版前已有的同一逻辑）。每个回复都结束忙状态，提示与错误仍按来源。RED→GREEN：`SaveDestination.test.tsx`。

### 检查

`55b37c5`：fmt、workspace strict Clippy、绑定重新生成无差异、Rust 721 通过／0 失败／12 忽略、tsc、前端 50 文件 354 项、43 个 e2e 模块 `node --check` 全部通过。`e2e/native-wall-pixels.test.py` 直接运行 4 例通过；`python -m unittest` 对连字符文件名会导入被测助手本身，无法装载（日志在 `work/t20/checks-redesign/10-python-pixels.log`）。`99194e1` 的首次全量前端为 351/352：既有封印预览测试在整套负载下 `findByRole` 超时；单文件连续 5 次与整套重跑均通过，原件保留。

### 原生轮次

r12–r20 均失败并保留原件，每轮新夹具，全部精确释放并恢复 KnownFolder。原因依次：遮罩残留（r12，产品）；结果卡遮住详情按钮（r13，harness）；幽灵“正在导入”（r14，产品）；钉住后未等来源重读（r15，harness）；同意时导入变更未结束、预览按设计关闭，以及卡片“浏览结果已变化”（r16，harness 与产品）；模态预览背后切换图库（r17，harness）；来源动作忙状态不清（r18，产品）；内容备份“读写备份失败：拒绝访问”（r19/r20，环境，见下）。r20 在 `55b37c5` 上连续通过 232 项：登记迁移、导入整理、来源动作、监视器与规则、固定任务归属、原型冻结点 148 张、Eagle、全部原图区域、封印同意与流撤销；止于内容备份。

- 备份失败的原因在本机环境。本工作树根目录下运行着一个 Vite 开发服务器（PID 27012，`--port 4199`，2026-10-10 13:47 启动，晚于 r11），它的递归监视持有 `work/` 下目录句柄，使目录改名被拒。r11 的原 EXE（`c45a80a4…`）今天同样 2/2 失败；同样的 SQLite 写入加改名在工作树内 10/10 失败，在工作树外 0/10 失败。该进程不属本代理，未结束。之后的内容与程序恢复、正常重启、离线断开和空白环境阶段同样依赖目录改名，本轮未验证。

### 原型对照

r20 同会话公开包（148 张，顺序与认可原型一致），新镜像与新 Edge profile：8 项通过。返回后锚点偏移为正式 465.2 px、原型 466.8 px（r11 为 386 px）。改版保留了图标轨、logo 与封印书；其余视觉差异属批准的改版，按差异记录，不强求一致。

### 审阅截图

隔离构建 `55b37c5` 的 WebDriver 窗口截图 19 张，只用夹具图片，原在根 `work/v1-handoff/follow-up-spec/t20-gui-review/redesign/`，下一节重拍后移到同级 `redesign-55b37c5/`（`index.json` 列出各张说明与 SHA256）。框选截图只保存本程序主窗口客户区的裁切。可见像素中没有主机名、用户路径或邮箱；导入对话框的“来自”折叠列表在 DOM 中含本机路径，但没有展开显示。

### 未验证与待定

- 上述 Vite 监视器停止后，需要在 `55b37c5` 上新开一轮完整组合运行（含空白环境）。（已由下一节 r21 完成。）
- 产品观察：详情面板打开时顶栏变窄，“精确查找”竖排换行；“编辑分组”对话框沿用旧侧栏的字形按钮，样式未适配；右下角卡片会盖住详情面板底部。（已由下一节修正。）
- release NSIS、#99、Windows 10、人工视觉验收、物理 DPI 与笔输入仍未验证。

## 视觉修正与完整复验（2026-10-11，本机 Win11）

最小派生记录：[redesign-final.json](evidence/spec78-t20/redesign-final.json)。原始轮次与截图在 ignored `work/e2e/spec78-t20-final-fed5ca4/` 与根 `work/v1-handoff/follow-up-spec/t20-gui-review/redesign/`。

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

最小派生记录：[redesign-details.json](evidence/spec78-t20/redesign-details.json)。原始轮次与截图在 ignored `work/e2e/spec78-t20-final-{abe2a38,fa00d08}/` 与根审阅目录。

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

最小派生记录：[release-nsis-lifecycle.json](evidence/spec78-t20/release-nsis-lifecycle.json)。构建日志、回执、轮次轨迹与截图只保存在 ignored `work/e2e/spec78-t20-release-{preflight-v1,nsis-*,lifecycle-r*}/`，按 SHA 引用；失败原件保持不变。

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
