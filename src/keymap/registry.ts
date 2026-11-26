import { type GestureBinding, type KeyBinding, type KeymapEntry, KeymapRegistry } from "./KeymapRegistry";

const key = (key: string, options: Partial<Omit<KeyBinding, "kind" | "key">> = {}): KeyBinding => ({
  kind: "key",
  key,
  ...options,
});
const gesture = (textKey: string): GestureBinding => ({ kind: "gesture", textKey });

/**
 * 页面内快捷键的声明表。`settings` 标出的条目由设置页直接渲染；
 * 未标出的条目是已经接入注册表、但设置页原来就没有列出的动作。
 */
export const KEYMAP_ENTRIES = [
  // 主窗口的固定按键（设置页第一组）。
  {
    scope: "main",
    action: "main.safeMode",
    labelKey: "settings:keys.safeMode",
    bindings: [key("s", { mod: true, shift: true })],
    editable: "allow",
    settings: { group: "main", hintKey: "settings:keys.fixedHint" },
  },
  {
    scope: "main",
    action: "main.zoomIn",
    labelKey: "settings:keys.zoomIn",
    bindings: [key("=", { mod: true }), key("+", { mod: true })],
    editable: "allow",
    settings: { group: "main", hintKey: "settings:keys.fixedHint" },
  },
  {
    scope: "main",
    action: "main.zoomOut",
    labelKey: "settings:keys.zoomOut",
    bindings: [key("-", { mod: true })],
    editable: "allow",
    settings: { group: "main", hintKey: "settings:keys.fixedHint" },
  },
  {
    scope: "main",
    action: "main.zoomReset",
    labelKey: "settings:keys.zoomReset",
    bindings: [key("0", { mod: true })],
    editable: "allow",
    settings: { group: "main", hintKey: "settings:keys.fixedHint" },
  },
  {
    scope: "main",
    action: "main.toggleInspector",
    labelKey: "settings:keys.details",
    bindings: [key("i")],
    ignoreRepeat: true,
    settings: { group: "main", hintKey: "settings:keys.fixedHint" },
  },
  {
    scope: "main",
    action: "main.importImages",
    labelKey: "wall:menu.importFiles",
    bindings: [key("o", { mod: true, shift: false })],
    editable: "allow",
  },
  {
    scope: "main",
    action: "main.togglePane",
    labelKey: "shell:emptyPane.collapse",
    bindings: [key("b", { mod: true, shift: false })],
    editable: "allow",
  },
  {
    scope: "main",
    action: "main.sectionBrowse",
    labelKey: "shell:nav.browse",
    bindings: [key("1", { mod: true, shift: false })],
    editable: "allow",
  },
  {
    scope: "main",
    action: "main.sectionGroups",
    labelKey: "shell:nav.groups",
    bindings: [key("2", { mod: true, shift: false })],
    editable: "allow",
  },
  {
    scope: "main",
    action: "main.sectionCaptures",
    labelKey: "shell:nav.captures",
    bindings: [key("3", { mod: true, shift: false })],
    editable: "allow",
  },
  {
    scope: "main",
    action: "main.sectionSubscriptions",
    labelKey: "shell:nav.subscriptions",
    bindings: [key("4", { mod: true, shift: false })],
    editable: "allow",
  },

  // 图片墙动作。
  {
    scope: "wall",
    action: "wall.pin",
    labelKey: "common:image.pinWhole",
    bindings: [key("p")],
  },
  {
    scope: "wall",
    action: "wall.crop",
    labelKey: "common:image.pinPart",
    bindings: [key("F1")],
  },
  {
    scope: "wall",
    action: "wall.trash",
    labelKey: "common:image.trash",
    bindings: [key("Delete")],
  },
  {
    scope: "wall",
    action: "wall.selectAll",
    labelKey: "wall:menu.selectAll",
    bindings: [key("a", { mod: true, shift: false })],
  },
  {
    scope: "wall",
    action: "wall.copy",
    labelKey: "common:image.copy",
    bindings: [key("c", { mod: true, shift: false })],
  },
  {
    scope: "wall",
    action: "wall.paste",
    labelKey: "wall:menu.importClipboard",
    bindings: [key("v", { mod: true, shift: false })],
  },

  // 查看器（设置页第二组；前三个是非键盘操作）。
  {
    scope: "viewer",
    action: "viewer.zoom",
    labelKey: "settings:keys.viewer.zoom",
    bindings: [gesture("settings:keys.key.wheel")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.pan",
    labelKey: "settings:keys.viewer.pan",
    bindings: [gesture("settings:keys.key.drag")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.cropGesture",
    labelKey: "settings:keys.viewer.crop",
    bindings: [gesture("settings:keys.key.shiftDrag")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.cropMode",
    labelKey: "settings:keys.viewer.cropMode",
    bindings: [key("F1")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.previous",
    labelKey: "settings:keys.viewer.previous",
    bindings: [key("ArrowLeft")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.next",
    labelKey: "settings:keys.viewer.next",
    bindings: [key("ArrowRight")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.fit",
    labelKey: "settings:keys.viewer.fit",
    bindings: [key("0")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.actual",
    labelKey: "settings:keys.viewer.actual",
    bindings: [key("1")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.pin",
    labelKey: "settings:keys.viewer.pin",
    bindings: [key("p")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.details",
    labelKey: "settings:keys.viewer.details",
    bindings: [key("i")],
    settings: { group: "viewer" },
  },
  {
    scope: "viewer",
    action: "viewer.back",
    labelKey: "settings:keys.viewer.back",
    bindings: [key("Escape", { mod: "any", alt: "any" })],
    settings: { group: "viewer" },
  },

  // 查看器已有、但设置页原来没有列出的键盘操作。
  {
    scope: "viewer",
    action: "viewer.flip",
    labelKey: "viewer:tools.flipHorizontal",
    bindings: [key("h")],
  },
  {
    scope: "viewer",
    action: "viewer.zoomIn",
    labelKey: "viewer:zoomIn",
    bindings: [key("="), key("+")],
  },
  {
    scope: "viewer",
    action: "viewer.zoomOut",
    labelKey: "viewer:zoomOut",
    bindings: [key("-"), key("_")],
  },
  {
    scope: "viewer",
    action: "viewer.copy",
    labelKey: "common:image.copy",
    bindings: [key("c", { mod: true, shift: false })],
  },
  {
    scope: "viewer",
    action: "viewer.pinCrop",
    labelKey: "common:image.pinPart",
    bindings: [key("Enter", { mod: "any", alt: "any" })],
  },

  // 订阅页搜索。
  {
    scope: "subscriptionSearch",
    action: "subscriptionSearch.open",
    labelKey: "subscriptions:browse.search",
    bindings: [key("f", { mod: true, shift: false, editable: "allow" }), key("/")],
  },
  {
    scope: "subscriptionSearch",
    action: "subscriptionSearch.close",
    labelKey: "subscriptions:browse.closeSearch",
    bindings: [key("Escape", { mod: "any", alt: "any" })],
    editable: "allow",
  },
  {
    scope: "subscriptionSearch",
    action: "subscriptionSearch.submit",
    labelKey: "subscriptions:browse.search",
    bindings: [key("Enter", { mod: "any", alt: "any" })],
    editable: "allow",
  },
] as const satisfies readonly KeymapEntry[];

export const keymapRegistry = new KeymapRegistry(KEYMAP_ENTRIES);
export type KeymapAction = (typeof KEYMAP_ENTRIES)[number]["action"];
