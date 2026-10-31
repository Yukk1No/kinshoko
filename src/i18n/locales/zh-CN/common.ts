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
  /** 选保存位置（`library/SaveDestination.tsx`）：收藏截图、复制到、导入参考组包与导入。 */
  saveDestination: {
    chooseBoth: "请选择图库和文件夹",
    unassigned: "未归类",
    folderGone: "这个文件夹不在了",
    libraryClosed: "未打开的图库",
    label: "{{library}} / {{folder}}",
    legend: "保存位置",
    library: "图库",
    putInLibrary: "放到图库",
    chooseLibrary: "选择图库…",
    libraryOption: "{{name}}（{{path}}）",
    libraryOptionOffline: "{{name}}（{{path}}）（未连接）",
    folder: "文件夹",
    putIn: "放到：{{place}}",
    loading: "正在读取图库…",
    unavailable: "这个位置现在用不了。请接上原图库，或换一个位置。",
    description: "选好图库和文件夹。",
    save: "保存",
    cancel: "取消",
    saving: "正在保存…",
  },
};
