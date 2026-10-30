/** 设置 › 更新与主窗口的更新通知（`src/Update.tsx`）。 */
export default {
  group: "更新",
  currentVersion: "当前版本",
  upToDate: "已是最新",
  available: "有新版本",
  checkFailed: "检查失败",
  manual: {
    title: "手动更新",
    hint: "从托盘退出，再运行新安装包",
    steps: "从托盘退出 Kinshoko 后，运行开发者提供的新版安装包，安装到原位置。装好后重新打开，继续使用已有图库、设置、参考组和钉图。",
    showSteps: "查看步骤",
    hideSteps: "收起步骤",
  },
  automatic: {
    title: "自动更新",
    disabled: "这个版本未开启",
  },
  channel: {
    title: "更新通道",
    stable: "正式版",
    beta: "测试版",
    stableHint: "只收正式版",
    betaHint: "收测试版、候选版和正式版",
  },
  install: {
    title: "可以更新到 {{version}}",
    hint: "装好后自动重启",
    action: "安装并重启",
  },
  check: {
    title: "检查更新",
    hint: "从发布页查找新版本",
    action: "检查更新",
  },
  progress: {
    starting: "正在下载更新…",
    downloaded: "正在下载 {{downloaded}} MB",
    downloadedOfTotal: "正在下载 {{downloaded}}／{{total}} MB",
  },
  notice: {
    available: "Kinshoko {{version}} 可以更新",
    installing: "正在更新到 {{version}}",
    failed: "更新失败",
    retry: "重试",
  },
};
