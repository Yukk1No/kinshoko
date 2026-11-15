/** 应用壳（Tauri 命令层）的错误。 */
export default {
  noLibrary: "还没有图库",
  libraryNotOpen: "还没有打开图库",
  referenceGroupsNotReady: "参考组还没有准备好",
  saveTargetMismatch: "要保存到的图库与导入任务不一致",
  unknownInterfaceLanguage: "没有这种界面语言：{{lang}}",
  autostartFailed: "无法更改开机启动：{{cause}}",
  clearRunLogFailed: "清除运行日志失败：{{detail}}",
  runLogNotOpen: "运行日志没有打开",
  diagnosticsSaveFailed: "保存诊断信息失败：{{cause}}",
  webView2PageFailed:
    "无法打开微软 WebView2 下载页。请在浏览器访问 https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
  visitWebView2Page: "请在浏览器访问 https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
  openExplorerFailed: "无法打开资源管理器：{{detail}}",
  openInFileManager: "请在资源管理器中打开：{{path}}",
  noMonitor: "未找到显示器",
  updateCheckFailed: "检查更新失败，请检查网络后重试。",
  updateManual: "当前使用安装包手动更新。",
  updateNoPublicKey: "未配置更新公钥，自动更新未启用。请使用新版安装包手动更新。",
  updateNoEndpoint: "未配置原仓库的公开更新入口，自动更新未启用。请使用新版安装包手动更新。",
  updateUnknownStage: "更新阶段配置无法识别，自动更新未启用。请使用新版安装包手动更新。",
  updateNotPending: "没有可以安装的更新，请先检查更新。",
  updateSignatureInvalid: "更新包没有通过验证，没有安装。请重新下载或手动更新。",
  updateInstallFailed: "下载或安装更新失败，请稍后重试。",

  tagMappingSafeModeChanged: "安全模式已变化，请重新检查标签对应",
  tagNamesSafeModeChanged: "安全模式已变化，请重新读取标签名称",
  nameMigrationSafeModeChanged: "安全模式已变化，请重新打开“确认旧名称”",

  definitionsNotSaved: "标签信息未存进图库：{{cause}}。程序里的对应和名称选择已保留；图库可写后，请重试保存标签信息。",
  mappingDefinitionsNotSaved:
    "标签对应已保存在程序里，但图库里的标签信息还没更新：{{cause}}。请在设置 › 标签 › 对应里重新存进图库。",
  tagEditDefinitionsNotSaved:
    "标签整理已保存，但图库里的标签信息还没更新：{{cause}}。请在设置 › 标签 › 对应里重新存进图库。",
  sourceTagDefinitionsNotSaved:
    "这个来源的标签整理已保存，但图库里的标签信息还没更新：{{cause}}。请在设置 › 标签 › 对应里重新存进图库。",
  packageDefinitionsNotSaved:
    "内容已写入，但图库里的标签信息还没更新：{{cause}}。请在设置 › 标签 › 对应里重新存进图库，或重新导入参考组包。",
  processedDefinitionsNotSaved:
    "内容处理结果已保留，图库里的标签信息还没更新：{{cause}}。可在设置 › 标签 › 对应里重新存进图库。",
  savedDefinitionsNotSaved: "内容已保存，图库里的标签信息还没更新：{{cause}}。可在设置 › 标签 › 对应里重新存进图库。",
  importPublicationNotStarted:
    "导入已开始，但无法开始更新图库里的标签信息：{{cause}}。导入完成后，可在设置 › 标签 › 对应里重新存进图库。",

  autostartNotSynced: "开机启动设置未同步：{{cause}}",
  safeModeScopeIncomplete: "安全模式范围未完全生效：{{cause}}",
  libraryNamesNotRefreshed: "图库名称未刷新：{{cause}}",
  libraryListNotRefreshed: "图库列表未刷新：{{cause}}",

  noBackupTarget: "还没有选择备份位置",
  backupTargetMissing: "备份位置不在：{{path}}",
  backupRunning: "正在备份，请等这次完成",
  backupOrRestoreRunning: "正在备份或恢复，请等这次完成",

  noCaptureInProgress: "没有进行中的截图",
  captureSessionExpired: "这次截图已中断，请重新框选",
  captureSourceClosed: "参考图已关闭，请重新框选",
  captureSourceMoving: "参考图正在移动，请重新框选",
  captureSafeModeChanged: "安全模式已变化，请重新框选",
  captureSourceBoundsInvalid: "无法确认参考图的位置，请重新框选",
  captureMainWindowRebuilt: "主窗口刚刷新过，请重新框选",
  captureSourcesUnconfirmed: "无法确认当前可见参考图，请重新框选",

  pinClosed: "钉图已关闭",
  pinLocked: "钉图已锁定",
  pinVeiledNoCopy: "安全模式下已遮蔽，不能复制",
  pinCaptureGone: "这张截图已删除",
  captureLeftHistory: "这张截图已删除，请关闭这张钉图后重试",
  captureSavePlanChanged: "桌面截图有变化，请重新选择每张截图存到哪里",
  captureCollectIncomplete:
    "第 {{number}} 张截图的收藏未完成：{{cause}}。之前完成的 {{completed}} 张收藏已保留；参考组尚未保存。",
  clipboardNoImage: "剪贴板里没有图片",
  clipboardImageUnrecognized: "剪贴板里的图片无法识别",
  copiedImageEmpty: "复制的图片是空的",
  copiedImageTooWide: "复制的图片太宽",
  copiedImageTooTall: "复制的图片太高",
  copiedImageTooLarge: "复制的图片太大",
  copiedImageNoMemory: "无法为复制的图片分配内存",
  copyPrepareFailed: "无法准备复制的图片：{{detail}}",
  clipboardNoWindow: "没有可用于复制的程序窗口",
  clipboardFormatUnavailable: "无法注册图片剪贴板格式",
  clipboardOpenFailed: "无法打开剪贴板：{{detail}}",
  clipboardWriteFailed: "无法写入剪贴板：{{detail}}",
  clipboardPartlyWritten: "图片已复制，但部分程序可能无法粘贴：{{detail}}",
};
