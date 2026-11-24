# 78 T20 — 最终组合验收（2/4）

[返回索引](../spec-78-t20.md)

## 原图组合阶段的新增离线准备

新增 [spec78-combination-original.mjs](https://github.com/Yukk1No/kinshoko/blob/3857dd8f/e2e/spec78-combination-original.mjs) 和纯文件 [spec78-combination-original-pixels.py](https://github.com/Yukk1No/kinshoko/blob/3857dd8f/e2e/spec78-combination-original-pixels.py)。本段是待运行的脚本行为。没有启动程序、原型、CIM、编译器或构建，也没有读取屏幕或剪贴板。

脚本直接读取固定 T17 `1d188e52a9639319dbaf90de9fe46a9a6fcea9b3` 的公开 capture、PinFrame 和像素工具契约。没有 import 旧顶层 runner。当前部分产品 `b856` 即使已加入该脚本，也会在启动前被祖先门槛拒绝。最终来源仍须由根代理合入后重新冻结。原生观察器由真实集成带入，不预先拷贝或修改冻结 T17 输入。

同一真实 A/B 会话内，脚本计划核对图片墙、虚拟返回与真实侧栏重排、适应窗口的 A 查看器，以及明确 B 来源的局部钉图。钉图实际经过水平翻转、顺时针四分之一圈和缩放。选区由真实 overlay 的 pointer 拖动与实际物理选区读取；截图必须显示完整尺寸和三个操作按钮。复制后直接只读实际 OS 剪贴板，再将完整 RGBA、透明度和尺寸与原图区域比较。原图动作不得增加普通截图历史。新钉图须保留明确 provider／image、原图 crop 和变换。

两类失效检查保留同一会话：从实际 B pin WebView 调用其有权限的 `close_pin`，确认该窗口销毁而冻结选区仍存在；另将明确 A 来源（图片，不是图库）移入回收站，确认 byte-identical B 仍可用。关闭钉图的完成动作须返回真实业务错误，剪贴板 RGBA／尺寸和普通历史保持原样；回收站来源一项后来由负责人决定为允许复制（见“未验证与待定”）。A 之后通过明确恢复动作还原。没有通过 main 关闭 pin，也没有放宽正式 ACL。

纯文件 oracle 用精确分数反解几何边缘，读取本轮已导入原图的真实 RGBA。它不调用 ImageGrab 或 Win32。原生观察器只会在根代理新 grant 的正式阶段执行。钉图手工 rAF 动画还必须等实际 canvas BCR×DPR 与 native content 完全对齐，不能只看 `getAnimations()`。画布若禁止 JS 读回，会保留该状态；实际冻结选区仍须显示非占位的图片细节。不能把未执行的像素比较称为原图质量通过。

构建门槛另要求 `CARGO_BUILD_TARGET` 与 `TAURI_CONFIG` 两个变量均不存在，空值也拒绝。实际构建动作才运行并保留 `rustc -vV`、`cargo -vV`、`rustc --print sysroot` 和明确 compiler 的版本命令／退出／原始日志。选用的 compiler SHA、实际 Windows MSVC host、显式 `--target`、继承环境及 jobs=2 均记录。产物从 `<own-target>/<actual-host>/<profile>` 冻结，不能从继承 target 猜路径。失败的工具链观察也保留在失败回执。

本轮离线检查原件在 ignored `work/e2e/spec78-t20-original-preparation-1791508193093/`。前四个检查器轮次分别保留：缺 Babel parser；错误假设 TypeScript 7 提供旧 API；错误 EOF 名称造成约30秒 Node heap OOM／退出134；有界扫描后发现当前未集成树缺 T17 原生观察器。它们属于检查器或未满足的集成前提，不属于正式程序结果。根代理已核对 OOM 负载没有与 T17 fullwall 轮重叠。诊断独占期间已暂停扫描和检查。根代理确认释放后，最终有界8项辅助检查通过；纯文件7项检查通过，含16种翻转／四分之一圈组合。最终原件另存在 `work/e2e/spec78-t20-original-final-checks-1791509076541/`。嵌入的浏览器脚本只做语法编译，没有执行。当前缺失观察器仍按未满足记录；T17 合入后必须再核真实依赖。

最小派生记录：[combination-original-preparation.json](../evidence/spec78-t20/combination-original-preparation.json)。全部原始输入、失败和最终检查分别绑定实际字节与 SHA。不能累计为正式组合验收。

原型输入采用探索记录 `prototype-final-packet-notes.md`（仓库外 SHA `450ce2c43ffa10b78edbbce25a9586ef21a633b364e573100830a0da409580e3`）。正式包使用本轮 public A 全页顺序、逐来源真实 collectedAt 和 exact 原图；不能继承旧43张、编日期或取子集凑一致。认可原型的 date DESC stable sort 必须实际保持同序。旧 `.local` 全目录和既有 browser profile 均须保留。该方案尚未执行。

## 最终验收的范围（已执行，见后文）

T17 已合入后才做最终构建。主操作使用同一最终 EXE、同一会话和两份独立真实资料库，覆盖迁移、查找、来源整理、保存目标、框选、任务限定展开和两类恢复。重启、空白环境、干净安装和实际旧版升级分别记录生命周期，不累计旧脚本子项冒充组合结果。这些都已执行：组合原生轮次见“最终组合运行”及之后各节，干净安装与升级见“release NSIS 干净安装与升级”。

Windows10没有可用设备或虚拟机。负责人明确接受其未验证状态。实际Windows11、物理显示、输入和开发者真机结果只按执行事实记录。旧11项CI颜色失败和前置未完成验收保持原状态。外部签名自动更新仍归 #99，不由本单代替。

## 同一会话中的原型对照检查点

新增 `e2e/spec78-combination-prototype.mjs`。正式工作流将检查点放在固定保存目标验证之后、Eagle 重导之前，仍使用同一最终构建、A/B 会话且早于生命周期切换。固定工单与计划第10步没有要求在全部 Eagle 动作之后才取包。该位置不是对后续 Eagle 当前状态的描述。

正式阶段将用真实控件选择 A 全部范围并清空条件，保留完整 public 分页、同一 revision/total、实际 N、逐个明确 A 来源 inspection、真实 collectedAt、原图 SHA/尺寸和实际 viewport/DPR/字体。认可原型仍按真实日期排序；只有排序实际保持 public 顺序，才能准备同序输入。兼容性当前未验证。不能编日期、静默重排、取子集，或套用旧43张。

输入准备采用新的 accepted-code 镜像，逐件复制认可代码、原字节 PNG 和四字体；配置源码不修改。镜像通过明确 junction 使用既有离线 prototype 依赖，是否成功解析仍须实际检查。旧 `.local` 整个目录只读盘点，前后必须相同；既有浏览器 profile 不复用。此阶段尚未实际创建镜像或运行浏览器。

模块另准备同卡片打开／适应／返回焦点、Enter/Escape、侧栏往返和窗口宽度往返的实际对照动作。实际 viewport 必须精确相等；每个字体 family/weight 都须成功加载。它只接收根代理另行授予且拥有的浏览器会话，不启动服务器或驱动。浏览器／服务器进程归属与释放 wrapper 尚待完成。原型的固定目录、空标签、Unknown 显示适配和页内钉图不能替代正式业务结论。

本次纯包 RED 为6成功／2失败，分别缺少 A 显示来源和安全模式下 Adult 输入拒绝。收口后8项成功；单文件语法成功。原件分别保存在 `work/e2e/spec78-t20-prototype-preparation-1791511114275/`，未覆盖旧轮。它们只使用合成公开响应，不是正式程序或原型结果。最小派生记录为 [combination-prototype-preparation.json](../evidence/spec78-t20/combination-prototype-preparation.json)。实际正式包、原型对照、安装和完整 T20 均未验证。


## 浏览器与 release NSIS 的离线准备候选

固定 `80d5764` 的独立只读审查只有一项 P2：`checker` 寻找认可原型中不存在的“背景：棋盘格”。本候选只把映射改成认可原型实际“棋盘”，四种背景都与实际 `GROUNDS` 对齐。认可原型代码未改。审查原件 SHA 为 `2f13b7faeebf377e1cd2053e5256ed7b97e29f3d83db54724007b3cd045d11e8`；80d 的检查与冻结原件保留。

新增 `e2e/spec78-combination-prototype-browser.mjs`。未来明确执行 `--run` 前必须有根代理对精确计划的新独占 grant。它计划使用实际 Node/Vite CLI、完整认可镜像配置、新的独立 headless Edge profile 与驱动。同样本、完整 N、viewport/DPR/字体和正式检查点仍由已有原型模块验证。这个 wrapper 不复用用户 profile。它保留最初 spawn 的 PID/path/creation，核对监听端口所有者、参数唯一性、已知子进程路径和创建时间。身份或查询失败会保留未释放状态；只有应用会话、服务器、驱动、profile 进程和两个实际端口均为空才能记录释放。CIM 全结果只用于内存筛选；不把无关用户进程命令写入回执。

新增 `e2e/spec78-combination-installer.mjs`。当前只准备同一 T19 隔离产品名／程序名／identifier 的 0.1.2 release 包。旧基线必须是实际 0.1.0 NSIS、原配置及原构建记录，明确保留其 debug 属性。本候选不会把旧 debug 验证变成 release 通过。未来单独允许构建后，先保存实际 Rust host/compiler/env，要求继承 `CARGO_BUILD_TARGET` 与 `TAURI_CONFIG` 都不存在；再记录 frontend、release native、NSIS bundle 三个命令、退出和原始日志。整个阶段核对真实 data/.cargo/source/dist/config，以及 native 前已存在的主 hook 和 bundle 前生成的实际 runtime include。

NSIS 编译期 helper 计划直接观测已被实际 bundler 修改的 EXE，将它与此构建裸 EXE 的精确三字节 marker 操作比较，然后独立冻结实际包内 EXE、安装包和全部 runtime DLL。它不把推导出来的 marker 字节称为提取的安装产物。真实 NSIS 语法、构建、payload、安装及 DLL 装载尚未执行。

本候选有界纯检查：browser 身份第一轮8成功／1失败，因已被独立识别的 child 创建时间没有与已识别 parent 比较；补相同身份层的时序门槛后9成功。原型 public packet 8成功，installer 准备9成功，helper 5成功。21段浏览器程序只做语法编译、0执行；两段 PowerShell 观察／终止程序只被解析为 AST、0执行。旧8／1失败原件、旧 installer 版本边界 RED 和80d旧轮均保留。合成 `.exe` 文件只是 marker 测试数据，没有被执行。

原件在 `work/e2e/spec78-t20-offline-wrapper-preparation-v1/`，最小派生索引为 [combination-browser-installer-preparation.json](../evidence/spec78-t20/combination-browser-installer-preparation.json)。本段为 additive T20 准备，不修改前置进度。真实 clean install 和 actual0.1.0 创建／保存→托盘正常退出→0.1.2 release `/UPDATE` 生命周期 runner 继续准备；两个 KnownFolder aliases 的既有 T19 字节、正式 Kinshoko Run 值和隔离安装归属必须重新核对并保全。浏览器、本机、安装、硬件和完整 T20 仍未验证。
