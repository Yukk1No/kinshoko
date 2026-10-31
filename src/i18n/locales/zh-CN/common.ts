/** 主窗口几处共用的文案：参考图的操作与结果、内容分级、按图库报告的失败。 */
export default {
  image: {
    pinWhole: "钉住整图",
    pinPart: "钉住局部",
    copy: "复制图片",
    reveal: "在资源管理器中显示",
    trash: "移到回收站",
    copied: "已复制图片",
    pinFailed: "无法钉住：{{error}}",
    copyFailed: "无法复制图片：{{error}}",
    revealFailed: "无法在资源管理器中显示：{{error}}",
  },
  /** 内容分级的四档，键是 `ContentRating`。 */
  rating: {
    general: "全年龄",
    sensitive: "轻度",
    questionable: "敏感",
    explicit: "成人",
  },
  /** 按图库报告没完成的部分：“「图库」：原因；「图库」：原因”。 */
  libraryFailure: "「{{name}}」：{{error}}",
  libraryFailureSeparator: "；",
};
