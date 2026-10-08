# #78 T17 / #95 瀑布流原图框选

本次是独立增量。没有改写前置 #42 / PR #71，没有继承其完成状态。
当前状态：实现已提交到工作分支，离线 Rust 检查通过；修复后新程序的原生整轮验收待执行。

## 结果与来源

正式墙面沿用认可原型 `prototype/reference-browser/src/components/Wall.tsx` 的布局、虚拟化与恢复定位。
有效单卡选区直接从该资料库的原图取像素。参考钉图保留资料库、参考图和原图裁切位置。
这两条参考路径都不新增截图历史。跨卡片、工具栏和外部应用区域继续普通截图。
冻结时已知的来源失效或被重新封印时返回错误，不回落旧屏幕帧。
T13 查看器背景属于程序设置；墙面按库滚动锚点继续留在设备本地。

## 冻结因果边界

只登记已加载、实际可见、未封印的挂载图片。使用实际 contain 图片边界、视口、滚动裁切和 DOM 遮挡。
来源携带明确的资料库 ID 和图像 ID，不能用另一库的相同内容代替失效来源。
原生抓屏前后使用一次性请求核对文档 instance、单调布局 generation 与物理几何。
滚动离开再返回相同矩形仍使 generation 变化。矩形相等不表示期间没有变化。
图片加载、DOM 变化、滚动、尺寸、过渡及虚拟回收都会撤销旧报告。
原生另核对 HWND、客户区原点、尺寸、DPI、前台/遮挡及单调窗口代次。
旧报告、旧 cancel 和旧 finish 只能命中其原始 token。主窗口重建不能复用旧 HWND 会话。

## 准备与最终提交

`CaptureSelection::prepare` 只解析来源、解码和裁切原图，或编码普通截图的内存数据。
`CaptureDraft::commit` 才写普通截图历史。丢弃准备结果不产生历史记录或临时文件。
既有 `CaptureSelection::finish` 仍提供 prepare 后立即 commit 的兼容入口；正式程序分开调用两步。
普通历史的公开真实文件测试覆盖丢弃、提交、重新打开、像素和 ICC；其旧原生探针无结论，不能称原生 RED 已复现。

Windows 复制先在锁外生成 PNG 与底部向上的 BGRA DIBV5。两种格式都保留直通 alpha。
独立 PNG 和 BMP 解码测试验证透明 RGB、alpha、通道和方向。实际 OS 互操作仍须原生验收。
最终授权通过后，安全 `clipboard-win` 封装才打开有实际 HWND 所有者的剪贴板，并先写 PNG，再补 DIBV5。
PNG 压缩、像素转换和原图解码都不持最终提交锁。
调试日志分别记录准备开始/结束和 OS 提交开始/结束，供实测耗时；不能提前宣称提交耗时上限。
没有新增我方 unsafe，也没有修改原图文件。

## 共享发布锁与撤销

`LibraryState.visibility_commit` 是共享 `Arc<Mutex<()>>`。`with_visibility_commit` 的调用形式保持。
正式复制/钉图在锁内重核冻结模式代次、严格全部来源可见性、来源尺寸和 pin 遮蔽，再执行实际副作用。
模式设置（含重复设置和失败保存的保守撤销）与完整程序设置替换使用同一锁。
T13 同模式恢复也递增代次并清除旧 reference、capture session 和逐张揭示状态；失败不保留旧授权。

登记、切换、新建、初次恢复、恢复注册和注销的来源状态提交使用同一锁。
实际 SourceEditor 的 `workspace_edit_source`、永久来源删除及兼容 edit/permanent_delete 也使用同一锁。
自动打标通过可选纯 Rust `TaggingConfig.publication_gate` 注入同一 Arc；默认 None 保留核心独立使用。
模型加载、推理与结果解释在锁外，标签、建议分级和完成标记在一个结果发布边界内写入。
取得锁后再次核对暂停/停止，迟到推理结果可被丢弃，恢复后可以重新打标。

参考授权按本次 `References.safe_mode` 与数据库中的有效分级计算 sealed，不信任共享 Library 的模式缓存。真实库公开 RED 复现了 active cache=off、操作 mode=on 时错误放行；修复后两个模式方向均按操作参数，且不修改共享缓存。此为公开行为证明，未复现 native 线程交错。

参考来源先核本次登记表，再取 active lens。注销先移除登记时，仍存活的旧 Arc 不能授权原图。真实库公开 RED 返回了不应可读的 ReferenceImage；修复后失败来源不会回落普通屏幕截图。原图动作的五个旧有效夹具补上真实登记，第六个失效夹具保留旧 lens 与空登记；原失败记录不改。
逐张揭示、模式提交中的揭示撤销、后台 forget 和 close 命令使用同一 gate。真实模式提交同步更新 PinVeils，避免事件跳过 off→on→off 时遗留揭示。事件线程只读取最新已提交设置，不重放迟到 bool；刷新窗口在 gate 外执行。
最终校验使用 PinVeils 的局部副本，早期解码前校验不会在 gate 外改实际揭示状态。最终 pin 来源同时要求记录仍存在且未 closing，并且原生窗口仍存在。
Destroyed 主线程只安排后台清理，不等待 gate；后台才按 gate→pins/veils/store/history 撤销。窗口构建失败的同步 closed 也改为后台，避免最终 pin 提交已经持 gate 时重入。公开 close 命令的 mark_closing 和 destroy 在 worker 的 gate 内串行。
物理 Destroyed 是异步通知，不把通知返回称为同步撤销完成；已经开始的最终 OS 提交可以先完成。关闭/removed 的新原生用例会先证明同一钉图原图命中，再通过真实 close 和 pin_frame=None 观察撤销，要求旧 frozen token 被拒绝且 OS 内容/历史不变。此用例当前仅语法检查，尚未执行。

锁序是 transition（需要时）→ visibility_commit → device/catalog/workspace/Shell/desktop 资源。
不得持资源锁进入 gate，不得在 gate 内 await、重入或 join 调度线程。
create/register/switch/初次恢复先完成来源状态，再在锁外 forward_events → attach；attach 先 detach 旧 worker。
unregister 先撤销并释放 gate，再 detach/drop/join worker，避免 worker 等 gate 而注销等 worker。
DeviceLibraries 的导入 settle 会等待导入任务；普通/Eagle 任务不取得此 gate。T13 模型设置只改 control 并 notify，不 join。
原生窗口创建可能同步派发主线程；相关窗口回调不取 gate 或 Shell 锁，Destroyed 的历史清理转交后台线程。

准备期间撤销可以先返回，准备结果随后必须被最终校验拒绝。
OS 提交一旦开始则按同一锁串行，撤销可能等待该次短提交完成；这不称为取消已经提交的图片。
准备、格式登记、窗口句柄或打开剪贴板失败时尚未清空旧内容。
Windows 不提供多格式事务：开始实际 set 后，OS 写入失败不能保证回滚；第二格式失败会报告部分互操作失败。
程序内模型自动分级纳入边界。其他进程直接修改 SQLite 或原图不受此进程的锁串行，最终读取只提供观察时校验。
参考组包和跨库复制通过同一 `PackageFacts` 提交点发布分级。`Library::use_package_publication_gate` 注入共享 Arc；`for_destination` 保留同一 inner。许可在调用线程进入 `writer.run` 前取得，仅覆盖短事务，不在 writer 闭包里反向等待许可。
参考组包先对固定 `CatalogInspection` 校验同一清单，再校验全部原图、读取、解码和导入；长 IO 不持 catalog 或 gate。`PackageImport` 暂不保存新组，App 在 gate→catalog 发布定义后才 finish。定义发布失败时保留已导入内容，参考组尚未保存。
普通/Eagle 导入的 `Origin.package` 固定为 None，不写 `rating_fact` 或 `rating_manual`，也不把已存在的可见图自动移入回收站。它们不取此 gate，因此注销 settle 的既有 import worker 不等待这把锁。Eagle 只可恢复同批刚创建且有初始回收站标记的图；不撤销已有可见来源。
真实资料库与真实参考组包的公开 RED 显示两条入口在许可被占用时均完成，已有同字节图有效分级均变为 Explicit；修复后等待许可释放再发布。包/复制尚无原生漏洞复现，此公开 RED 不冒称 native RED。完整写入点和锁序见 [写入审计](evidence/spec78-t17/package-publication/write-inventory.md)。

## 已保留的证据

旧模式晚写 RED：模式已返回，实际 OS 仍为 8×8 种子，稍后变为 1231×991 原图裁片。
原件位于 [native-red](evidence/spec78-t17/native-red/README.md)。修复后的独立 mode race GREEN 仍待新构建验收。

旧来源边界固定 d85 / actual build 173bb70 / EXE FEF8197…05EA1。
注销 run1791496969521：真实 baseline 7778×5189 全 RGBA 相同、无历史；注销已返回且真实 OS 仍空，约 4.7 秒后写入原图。
分级 run1791497183548：实际 edit 返回 manual/effective explicit；safe=true、成功 browse 排除后，约 5.1 秒仍写入同原图。
分级原始整轮为 failed-precondition-or-probe：末尾 image_rating 按可见性策略拒绝。原始状态不改，不称整轮通过。
根独立派生回执在 `work/v1-handoff/follow-up-spec/evidence/t17-native/root-derived-original-boundary-findings.json`，逐 RGBA 和 12 条因果均核对。
旧 ordinary history 探针没有命中撤销区间。旧来源 v1 跨了徽标，实际是普通截图；二者都不消除候选，也不冒称新 RED。

Wall 原生失败显示真实浏览已到下方，随后清空卡片把 scrollTop 夹回 0；发生在 focus 和 start_capture 之前。
公开 Wall 回归交付该 scroll-clamp 事件：旧代码期望 2000 实际 0，修复后恢复同卡偏移。
具体原生刷新触发事件尚未确认。新 harness 只读记录 library/workspace/模式事件，不靠延长等待隐藏浏览位置丢失。

离线 [commit-boundary 证据索引](evidence/spec78-t17/commit-boundary/index.json) 保存公开 RED/GREEN 和原始失败。
Rust 全量 76 targets：698 passed、0 failed、12 ignored；不重复计故障子进程。
严格 Clippy 通过。前端整轮 38 文件为 280 passed / 1 failed（SharedApprox 列表等待超时）；隔离 5 例通过不消除原失败，根另行只读诊断。
该检查的产品主体为 0f5ea7a 加尚未提交的 capture/history/clipboard 草稿；不是已冻结原生新试件。
后续加入调试时间戳仅复验受影响 adapter，最终合入最新 integration 后再做完整检查与新冻结。

## 尚未验证

新构建完整 Wall、外部实际蓝窗遮挡、已修 mode/provider/rating 撤销和真实 OS PNG/DIBV5 互操作待独立桌面授权。
旧多轮只能按完整轮或部分轮分别记，不能累加已走过断言作为整轮成功。
Windows 10、系统 100/125/150% 与混合 DPI、实体 F1 和笔输入尚未验证。
强制 WebView DPR 不是系统 DPI 验证。最终仍需开发者真机验收。


## 最终构建前固定检查（2da427e）

此轮先合入根 b856，再在 clean `2da427ee5fb0666b7d7ba3c9e647c124ed65bfc7` / tree `8a70d4960e0758347f502af6d17b7ff4107d1dba` 执行一次必要完整检查。
前后 2166 个跟踪文件逐 SHA 相同，bindings 无差异。检查前完整清单以确定 mtime 的 gzip 逐字节保全。
前端 40 文件、286 测试全部通过；Rust 76 个父 target、710 成功、0 失败、12 ignored，另排除 7 个内嵌子进程结果。
strict workspace/all-targets Clippy、TypeScript、fmt 和验收脚本语法检查通过。原始输出、退出码及派生索引见 [final-v3-checks](evidence/spec78-t17/final-v3-checks/index.json)。
此前 280/281 的原始失败和未知原因仍保留，此次必要完整检查不追溯改写旧轮结果。
新程序原生 Wall、真实关闭贴图权限，以及 mode/provider/rating 准备阶段撤销仍未执行，等待固定新产物和根独立桌面授权。
