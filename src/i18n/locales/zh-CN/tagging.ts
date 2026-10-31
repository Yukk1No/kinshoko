/** 主窗口里的自动标签状态（`src/TaggingActivity.tsx`）：图片墙右下角的图标与通知。 */
export default {
  /** 打标所用的设备；键是 `Device`。 */
  device: {
    directMl: "显卡",
    cpu: "CPU",
  },
  activity: {
    downloading: "正在下载自动标签模型 {{percent}}%",
    starting: "正在加载自动标签模型",
    preparing: "正在校验自动标签模型",
    running_other: "正在自动标签，已标 {{count}} 张（{{device}}）",
    paused: "已暂停",
    yieldedToFullScreen: "因全屏程序暂停",
  },
  label: "自动标签：{{text}}",
  openSettings: "自动标签：{{text}}，打开自动标签设置",
  notice: {
    downloaded: "已下载自动标签模型",
    failed: "自动标签出错：{{reason}}",
    retrying: "稍后会自动重试",
    tagged_other: "自动标签：新打了 {{count}} 张",
    unavailable: "自动标签不可用：{{reason}}",
    downloading: "正在下载自动标签模型",
    downloadFailed: "无法下载自动标签模型：{{error}}",
    needsDownload: "需要下载自动标签模型（{{size}} MB）",
    resume: "继续下载",
    download: "下载",
  },
};
