/** 主窗口的外壳（`src/App.tsx`、`src/shell/`、`src/ui/`）：导航栏、窗口按钮、提示、启动与没有图库时的页面。 */
export default {
  nav: {
    label: "主导航",
    browse: "图片与文件夹",
    groups: "参考组",
    captures: "截图历史",
    settings: "设置",
    settingsTip: "程序设置",
  },
  safeMode: {
    on: "安全模式：开启",
    off: "安全模式：关闭",
    tipOn: "安全模式：开，成人图已封印",
    tipOff: "安全模式：关",
    toggleFailed: "无法切换安全模式：{{error}}",
  },
  window: {
    minimize: "最小化",
    maximize: "最大化",
    restore: "还原",
    close: "关闭",
  },
  toast: {
    label: "提示",
    gotIt: "知道了",
    dismissLabel: "关闭提示",
    dismiss: "关闭",
  },
  import: {
    label: "导入",
    busyLabel: "正在导入",
    files: "图片",
    folder: "文件夹",
    eagle: "从 Eagle 导入",
    findingEagle: "正在查找 Eagle 图库…",
    tasks: "导入任务",
  },
  dock: "工具",
  /** 带快捷键的工具按钮的读屏名称。 */
  dockItem: "{{label}}，{{shortcut}}",
  resizeInspector: "调整详情宽度",
  resizeInspectorTitle: "调整宽度",
  opening: "正在打开图库…",
  openingLabel: "正在打开图库",
  openFailed: "上次的图库无法打开：{{error}}",
  uiScaleFailed: "无法更改界面缩放：{{error}}",
  /** 还没有图库时，侧栏里的参考组与截图历史。 */
  emptyPane: {
    groups: "参考组",
    captures: "截图",
    capturesLabel: "截图历史",
    collapse: "收起侧栏",
  },
  backToLibrary: "返回图库",
  back: "返回",
  settingsTitle: "程序设置",
  closeSettings: "关闭设置",
};
