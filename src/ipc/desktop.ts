import type { SaveDestination } from "../bindings/SaveDestination";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CaptureAction } from "../bindings/CaptureAction";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { CollectedCapture } from "../bindings/CollectedCapture";
import type { FrozenScreen } from "../bindings/FrozenScreen";
import type { OriginalPixels } from "../bindings/OriginalPixels";
import type { PinFrame } from "../bindings/PinFrame";
import type { PinMenuOpen } from "../bindings/PinMenuOpen";
import type { OpenInKinshoko } from "../bindings/OpenInKinshoko";
import type { Region } from "../bindings/Region";
import type { ScreenRect } from "../bindings/ScreenRect";
import type { Turn } from "../bindings/Turn";
import { desk } from "./plugins";
import { captureUrl } from "./groups";

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

/** 本钉图层里这个钉图当前的一帧：要画什么、层窗口与内容的位置；钉图已关闭或不在本层时为 null。 */
export function pinFrame(pin: string): Promise<PinFrame | null> {
  return invoke<PinFrame | null>(desk("pin_frame"), { pin });
}

/** 发给本钉图层、关于这个钉图的帧（缩放、贴边滑动、翻转旋转、透明度、锁定、上下次序，#64、#193）。 */
export function onPinFrame(pin: string, handler: (frame: PinFrame) => void): Promise<UnlistenFn> {
  return onLayerFrame((frame) => {
    if (frame.pin.id === pin) handler(frame);
  });
}

/** 发给本钉图层的全部帧：层据此知道有钉图进来了（#193）。 */
export function onLayerFrame(handler: (frame: PinFrame) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<PinFrame>("pin-frame", (e) => handler(e.payload));
}

/** 钉图离开了本层（关闭、拖到别的显示器、交给另一个层，#193）。 */
export function onPinGone(handler: (pin: string) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<string>("pin-gone", (e) => handler(e.payload));
}

/** 本钉图层此刻画着的钉图（#193）。 */
export function layerPins(): Promise<string[]> {
  return invoke<string[]>(desk("pin_layer_pins"));
}

/** 按下了这个钉图：它到最上面（#193）。 */
export function raisePin(pin: string): Promise<void> {
  return invoke<void>(desk("raise_pin"), { pin });
}

/** 动画结束：让应用壳把原生窗口改成静止时的矩形（只认最新一帧的 generation）。 */
export function settlePin(pin: string, generation: number): Promise<void> {
  return invoke<void>(desk("settle_pin"), { pin, generation });
}

/** 透明度 0.1～1。 */
export function setPinOpacity(pin: string, opacity: number): Promise<void> {
  return invoke<void>(desk("set_pin_opacity"), { pin, opacity });
}

/** 锁定后钉图不响应拖动与缩放。 */
export function setPinLocked(pin: string, locked: boolean): Promise<void> {
  return invoke<void>(desk("set_pin_locked"), { pin, locked });
}

/** 本钉图层画好了这个钉图的第一帧：层可以显示了，交接中的旧层可以放手了（#193）。 */
export function pinReady(pin: string): Promise<void> {
  return invoke<void>(desk("pin_ready"), { pin });
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

/** 画师确认显示这张被遮蔽的参考图（安全模式下，只这一张）。 */
export function revealPin(pin: string): Promise<void> {
  return invoke<void>(desk("reveal_pin"), { pin });
}

/**
 * 资料库钉图的图（经参考视角，只给已钉住的图）。size 为 "full"（1:1，原图或 sdr 派生图）或
 * 原图整张缩到的宽度（物理像素，精确尺寸的 sdr 派生图）。
 */
export function pinImageUrl(pin: string, size: "full" | number): string {
  return captureUrl(`pin/${pin}/${size === "full" ? "full" : `fit-${size}`}`);
}

/** 只关闭收到 Esc 的活动钉图窗口，沿用原生关闭后的保存与截图历史清理。 */
export function closePin(pin: string): Promise<void> {
  return invoke<void>(desk("close_pin"), { pin });
}

/** 在钉图上弹出右键菜单。 */
export function pinMenu(pin: string): Promise<void> {
  return invoke<void>(desk("pin_menu"), { pin });
}

/** 拖动钉图（笔、鼠标、触摸同一套）：移到屏幕物理像素 (x, y)，成为新的原位。锁定时 reject。 */
export function movePin(pin: string, x: number, y: number): Promise<void> {
  return invoke<void>(desk("move_pin"), { pin, x, y });
}

/** 缩放钉图；屏幕上的 (anchorX, anchorY)（物理像素）不动。新状态以 pin-frame 到达；锁定时 reject。 */
export function zoomPin(pin: string, scale: number, anchorX: number, anchorY: number): Promise<void> {
  return invoke<void>(desk("zoom_pin"), { pin, scale, anchorX, anchorY });
}

/** 翻转与旋转动作，来自 Rust `kinshoko_core::desktop::Turn` 的生成绑定。 */
export type PinTurn = Turn;

/** 翻转或旋转钉图（中心不动）。新状态以 pin-frame 到达。 */
export function turnPin(pin: string, turn: PinTurn): Promise<void> {
  return invoke<void>(desk("turn_pin"), { pin, turn });
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
