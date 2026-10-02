# Tauri 对本地绘画参考流程的适配评估

核验日期：2026-10-03（Asia/Shanghai）。对应 [评估 Tauri 对本地绘画参考流程的适配性](https://github.com/Yukk1No/kinshoko/issues/11)，属于 [首个本地版本决策地图](https://github.com/Yukk1No/kinshoko/issues/3)。仅核查一手资料，**未运行 Tauri 原型、未测性能**。

**建议（推论）：有条件采用 Tauri 2 作为优先原型。** 已有接口覆盖主要需求，尚未发现文档层面的阻碍；“快”须分别验证启动、图库响应、清晰显示和自动打标。原型通过后再决定正式框架。

## 官方事实与应用职责

**包体与启动。** Tauri 的 Rust Core 管业务，Windows 界面依赖 WebView2；默认应用包不携带完整浏览器，因此包体小不能直接推出冷启动快。离线首次部署须带离线安装器或 Fixed Runtime，另计其体积。Evergreen 共享且自动更新；Fixed 由应用维护补丁，两者都需记录版本并回归验证。[进程模型](https://v2.tauri.app/concept/process-model/)、[Windows 安装](https://v2.tauri.app/distribute/windows-installer/)、[Runtime 更新模式](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)

**图片与 IPC。** 官方支持 `ArrayBuffer`／`Uint8Array` 原始请求、`tauri::ipc::Response` 二进制返回，能避开 JSON/base64 编码；`convertFileSrc` 可让 WebView 经 asset 协议读本地文件，但须配置 scope 与 CSP。**建议：** 图库分页、只加载可见缩略图，观察时按需读原图；元数据走小消息，图片比较 asset 与 raw 路径。有界缓存、复制、解码和释放成本仍需测，二进制支持不等于零复制。[命令与二进制](https://v2.tauri.app/develop/calling-rust/)、[core API](https://v2.tauri.app/reference/javascript/api/namespacecore/)

**多张独立钉图。** WebView2 进程组含浏览器、renderer 和辅助进程；同配置、同用户数据目录的 environment 可共享进程组，renderer 也可能服务多个实例。不能预设每窗启动完整浏览器或内存线性增长。**建议：** 测 Core＋全部关联 WebView2 进程，以及每加一窗的增量、同图／不同图和关闭后释放。[WebView2 进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)

**无独显与后台任务。** WebView2 默认 GPU 渲染，Microsoft 建议仅排障时禁用；无独显／集显须实机验收，CPU 可用的打标路线另验，框架不会替模型加速。Tauri 异步命令在独立 async task 执行，普通同步命令默认在主线程；固定源码提供 `spawn_blocking`。**建议：** 导入、解码与 CPU 打标进入有界工作队列，网络用异步 I/O；进度用 Channel，形式按锁定 SDK 核验。应用负责取消检查与并发上限，热键／托盘回调不等待耗时任务；写成 `async` 不会消除阻塞计算。[WebView2 性能](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)、[命令调度](https://v2.tauri.app/develop/calling-rust/#async-commands)、[Tauri v2.8.5 固定源码](https://github.com/tauri-apps/tauri/blob/80eadb7387459639037e3a279c61c9631b1dafe7/crates/tauri/src/async_runtime.rs)

**数据与桌面边界。** 官方 SQL 插件支持 SQLite，HTTP 插件提供 Rust／JS 请求入口；SQLite＋原文件、远端打标接口均可作为方案，当前不冻结目录、数据库或备份格式。[SQL](https://v2.tauri.app/plugin/sql/)、[HTTP](https://v2.tauri.app/plugin/http-client/)。固定局部、方向校正后物理像素 1:1、EXIF／ICC、锁定与穿透独立、置顶及无焦点退出沿用 [桌面边界报告](windows-reference-feasibility.md)。先成功注册退出热键再开放穿透，保留托盘恢复；接口存在仍不能证明混合 DPI、画笔、画质和退出响应已通过。许可证条件也复用该报告。

## 最小 Tauri 运行验证

先用公开／自制样本，覆盖不足再补少量画师素材；记录样本哈希、release 构建、SDK／插件／Runtime、机器与显示器配置。以下**全部未实测**，验收阈值随使用反馈确定。

| 项目 | 必须记录／核对 | 状态 |
|---|---|---|
| 启动与部署 | 冷／热启动到可操作、应用包与 Runtime 各自体积；无开发环境的标准用户离线首次安装，Runtime 更新后复验 | 未实测 |
| 图库与图片路径 | 分页滚动、缩略图命中／未命中；asset 与 raw 的首次清晰显示、传输／解码时间、内存峰值；大图／损坏图报错及缓存释放 | 未实测 |
| 独立钉图 | 1／2／8 窗、同图／不同图：全部进程 CPU／内存、每窗增量、开关窗释放；成员 crop 与状态各自保存恢复 | 未实测 |
| 桌面与画质 | 像素网格 1:1、跨屏 DPI、固定局部、EXIF 1–8、ICC／透明图；绘画软件置顶、画笔穿透及锁定四种组合 | 未实测 |
| 后台与退出 | 导入／模拟 CPU 打标／延迟或失败的远端接口并行时，滚动、钉图、全局热键与托盘仍响应；热键冲突、取消与失败可恢复 | 未实测 |
| 无独显与数据 | 集显 Windows 上完成导入—观察—钉图—保存恢复；真实 CPU 打标速度待后续模型验证，本轮不下载权重 | 未实测 |

若退出、画质、无独显可用或多窗口资源成本未达反馈门槛，先定位瓶颈，再决定补实现或重开框架选择；本次研究不能标记运行检查通过。
