import type { SaveDestination } from "../bindings/SaveDestination";
import { invoke } from "./invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CaptureAction } from "../bindings/CaptureAction";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { CollectedCapture } from "../bindings/CollectedCapture";
import type { FrozenScreen } from "../bindings/FrozenScreen";
import type { OriginalPixels } from "../bindings/OriginalPixels";
import type { PinMenuOpen } from "../bindings/PinMenuOpen";
import type { OpenInKinshoko } from "../bindings/OpenInKinshoko";
import type { Region } from "../bindings/Region";
import type { ScreenRect } from "../bindings/ScreenRect";
import { desk } from "./plugins";

// ---------- 截图与钉图（#62） ----------


/** 开始框选截图（与全局快捷键相同）。 */
export function startCapture(): Promise<void> {
  return invoke<void>(desk("start_capture"));
}

/** 框选窗口：要显示的冻结屏幕；没有进行中的截图时为 null。 */
export function frozenScreen(): Promise<FrozenScreen | null> {
  return invoke<FrozenScreen | null>(desk("frozen_screen"));
}

/** 框选读数（#103）：选区（相对显示器的物理像素）得到参考视图时为结果的原始像素尺寸，普通截图为 null。 */
export function captureReadout(region: Region, token: string): Promise<OriginalPixels | null> {
  return invoke<OriginalPixels | null>(desk("capture_readout"), { region, token });
}

/** 框选窗口：冻结屏幕已画好，可以显示窗口了。 */
export function captureReady(token: string): Promise<void> {
  return invoke<void>(desk("capture_ready"), { token });
}

/** 框选完成；region 是相对显示器的物理像素。 */
export function finishCapture(region: Region, action: CaptureAction, token: string): Promise<void> {
  return invoke<void>(desk("finish_capture"), { region, action, token });
}

export function cancelCapture(token: string): Promise<void> {
  return invoke<void>(desk("cancel_capture"), { token });
}

/** 把剪贴板里的图片钉住；剪贴板没有图片时 reject 中文原因。 */
export function pinClipboard(): Promise<void> {
  return invoke<void>(desk("pin_clipboard"));
}

/** 从截图历史钉住一张截图。 */
export function pinCapture(id: string): Promise<void> {
  return invoke<void>(desk("pin_capture"), { id });
}

/**
 * 从查看器把参考图钉到桌面（#65）：整图（crop 为 null）或局部（原图像素）。
 * shown 是这块此刻在查看器里的位置（物理像素，相对窗口客户区），新钉图以它为中心略微错开。
 */
export function pinReference(
  libraryId: string,
  imageId: string,
  crop: Region | null,
  shown: ScreenRect,
): Promise<void> {
  return invoke<void>(desk("pin_reference"), { libraryId, imageId, crop, shown });
}

/** 复制图片（#105）：把参考图的原图像素放进剪贴板；没有这张图、被封印或原文件不在时 reject 中文原因。 */
export function copyReferenceImage(libraryId: string, imageId: string): Promise<void> {
  return invoke<void>(desk("copy_reference_image"), { libraryId, imageId });
}

/** 在资源管理器中显示（#105）：打开原文件所在的文件夹并选中它；文件不在时 reject 中文原因。 */
export function revealReferenceImage(libraryId: string, imageId: string): Promise<void> {
  return invoke<void>(desk("reveal_reference_image"), { libraryId, imageId });
}

/** 导入回执里未导入的文件（#388）：在资源管理器中选中它；文件已不在时打开原来的文件夹，都不在时 reject 中文原因。 */
export function revealImportSource(path: string): Promise<void> {
  return invoke<void>(desk("reveal_import_source"), { path });
}

/** 在资源管理器中打开图库（#114）：打开图库在本设备上的文件夹；不在原处时 reject 中文原因。 */
export function revealLibrary(libraryId: string): Promise<void> {
  return invoke<void>(desk("reveal_library"), { libraryId });
}

/** 剪贴板里有没有图片（只看格式，不读出）。 */
export function clipboardHasImage(): Promise<boolean> {
  return invoke<boolean>(desk("clipboard_has_image"));
}

/** 从剪贴板导入（#105）：把剪贴板图片暂存成 PNG，返回路径交给普通导入；没有图片时 reject 中文原因。 */
export function stageClipboardImport(): Promise<string> {
  return invoke<string>(desk("stage_clipboard_import"));
}

/** 贴边隐藏全部钉图，或让它们回到原位（与全局快捷键相同）。 */
export function edgeHide(): Promise<void> {
  return invoke<void>(desk("edge_hide"));
}

// ---------- 钉图菜单窗口（#102 T5，#106） ----------

/**
 * 钉图菜单里的一项（与 Rust `desktop/pins.rs` 的 `ACTION_*` 对应）。`opacity:<百分比>`、`group:<参考组 id>`。
 */
export type PinMenuAction =
  | "flipH" | "flipV" | "rotateCw" | "rotateCcw" | `opacity:${number}` | "lock" | "actualSize"
  | "collect" | "copy" | "reveal" | "saveGroup" | "openInKinshoko" | `group:${string}` | "edgeHide" | "close";

/** 菜单窗口此刻要显示的钉图菜单（窗口第一次建好时取；之后经 `desktop-menu` 事件到达）。 */
export function desktopMenu(): Promise<PinMenuOpen | null> {
  return invoke<PinMenuOpen | null>(desk("desktop_menu"));
}

/** 发给菜单窗口的新菜单：指针处又右键了一个钉图。 */
export function onDesktopMenu(handler: (open: PinMenuOpen) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<PinMenuOpen>("desktop-menu", (e) => handler(e.payload));
}

/** 菜单已画好：显示菜单窗口并让它拿到键盘焦点（Esc、方向键）。 */
export function desktopMenuShown(generation: number): Promise<void> {
  return invoke<void>(desk("desktop_menu_shown"), { generation });
}

/** 菜单关掉了（Esc、点外部、窗口失去焦点）：隐藏菜单窗口。 */
export function closeDesktopMenu(generation: number): Promise<void> {
  return invoke<void>(desk("close_desktop_menu"), { generation });
}

/** 选了钉图菜单里的一项：先收起菜单窗口，再对钉图做这件事；提示显示在钉图上。 */
export function pinMenuAction(pin: string, action: PinMenuAction, generation: number): Promise<void> {
  return invoke<void>(desk("pin_menu_action"), { pin, action, generation });
}

/** 钉图菜单“在 Kinshoko 中打开”留给主窗口的请求；没有时为 null。取走后清空。 */
export function takeOpenRequest(): Promise<OpenInKinshoko | null> {
  return invoke<OpenInKinshoko | null>(desk("take_open_request"));
}

/** 钉图菜单请主窗口打开参考图或截图历史（随后用 takeOpenRequest 取）。 */
export function onOpenRequest(handler: () => void): Promise<UnlistenFn> {
  return listen("open-in-kinshoko", () => handler());
}

/** 把截图历史中的一张截图复制到剪贴板（截图历史条目菜单“复制”）。 */
export function copyCapture(id: string): Promise<void> {
  return invoke<void>(desk("copy_capture"), { id });
}

export function captureHistory(): Promise<CaptureEntry[]> {
  return invoke<CaptureEntry[]>(desk("capture_history"));
}

/** 收藏：经资料库的普通导入入口存进当前资料库。 */
export function collectCapture(id: string, destination:SaveDestination): Promise<CollectedCapture> {
  return invoke<CollectedCapture>(desk("collect_capture"), { id, destination });
}

export function deleteCapture(id: string): Promise<void> {
  return invoke<void>(desk("delete_capture"), { id });
}

export function onCaptureHistory(handler: (entries: CaptureEntry[]) => void): Promise<UnlistenFn> {
  return listen<CaptureEntry[]>("capture-history", (e) => handler(e.payload));
}

// ---------- 参考组（#66） ----------
