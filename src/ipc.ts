// 前端调用 Tauri 命令的唯一入口。参数与返回值的类型来自 ts-rs 生成的 ./bindings，
// 不在这里手写；Rust 侧改了类型，重新生成后这里会在类型检查时报错。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowsePage } from "./bindings/BrowsePage";
import type { BrowseQuery } from "./bindings/BrowseQuery";
import type { CaptureAction } from "./bindings/CaptureAction";
import type { CaptureEntry } from "./bindings/CaptureEntry";
import type { CollectedCapture } from "./bindings/CollectedCapture";
import type { FrozenScreen } from "./bindings/FrozenScreen";
import type { PinInfo } from "./bindings/PinInfo";
import type { Region } from "./bindings/Region";
import type { LibraryEvent } from "./bindings/LibraryEvent";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { ShortcutAction } from "./bindings/ShortcutAction";

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

const lib =(command: string) => `plugin:library|${command}`;

/** 当前资料库；启动后第一次调用时打开本设备上次打开的资料库。 */
export function currentLibrary(): Promise<LibraryInfo | null> {
  return invoke<LibraryInfo | null>(lib("current_library"));
}

/** 在 parent 下新建名为 name 的资料库，登记到本设备并打开。 */
export function createLibrary(parent: string, name: string): Promise<LibraryInfo> {
  return invoke<LibraryInfo>(lib("create_library"), { parent, name });
}

export function browse(query: BrowseQuery): Promise<BrowsePage> {
  return invoke<BrowsePage>(lib("browse"), { query });
}

/** 开始导入，立即返回任务 id；进度与结果经 onLibraryEvent 推送。 */
export function startImport(paths: string[]): Promise<string> {
  return invoke<string>(lib("start_import"), { source: { paths } });
}

export function cancelImport(taskId: string): Promise<void> {
  return invoke<void>(lib("cancel_import"), { taskId });
}

export function onLibraryEvent(handler: (event: LibraryEvent) => void): Promise<UnlistenFn> {
  return listen<LibraryEvent>("library-event", (e) => handler(e.payload));
}

/** 卡片上的缩略图地址（自定义协议 thumb）转成 <img> 可用的 URL。 */
export function thumbnailUrl(address: string): string {
  return convertFileSrc("", "thumb") + address;
}

// 原生文件对话框无法由 WebDriver 操作。冒烟测试先把要“选中”的路径放进
// window.__KINSHOKO_TEST_PICKS__，有值时按顺序取用，不弹对话框。
declare global {
  interface Window {
    __KINSHOKO_TEST_PICKS__?: (string | string[] | null)[];
  }
}

function testPick<T>(): { value: T } | null {
  const queue = window.__KINSHOKO_TEST_PICKS__;
  return queue && queue.length ? { value: queue.shift() as T } : null;
}

export function pickFolder(): Promise<string | null> {
  const t = testPick<string | null>();
  return t ? Promise.resolve(t.value) : invoke<string | null>(lib("pick_folder"));
}

export function pickFiles(): Promise<string[]> {
  const t = testPick<string[]>();
  return t ? Promise.resolve(t.value ?? []) : invoke<string[]>(lib("pick_files"));
}

/** 应用壳设置：开机自启与全局快捷键。 */
export function shellSettings(): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("shell_settings");
}

/** 开关开机自启。失败时 reject 一条给画师看的中文原因。 */
export function setAutostart(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_autostart", { on });
}

/** 更换全局快捷键，立即生效；`null` 表示清除。失败时 reject 中文原因，原来的键不变。 */
export function rebindShortcut(
  action: ShortcutAction,
  accelerator: string | null,
): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("rebind_shortcut", { action, accelerator });
}

// ---------- 截图与钉图（#62） ----------

const desk = (command: string) => `plugin:desktop|${command}`;

/** 开始框选截图（与全局快捷键相同）。 */
export function startCapture(): Promise<void> {
  return invoke<void>(desk("start_capture"));
}

/** 框选窗口：要显示的冻结屏幕；没有进行中的截图时为 null。 */
export function frozenScreen(): Promise<FrozenScreen | null> {
  return invoke<FrozenScreen | null>(desk("frozen_screen"));
}

/** 框选窗口：冻结屏幕已画好，可以显示窗口了。 */
export function captureReady(): Promise<void> {
  return invoke<void>(desk("capture_ready"));
}

/** 框选完成；region 是相对显示器的物理像素。 */
export function finishCapture(region: Region, action: CaptureAction): Promise<void> {
  return invoke<void>(desk("finish_capture"), { region, action });
}

export function cancelCapture(): Promise<void> {
  return invoke<void>(desk("cancel_capture"));
}

/** 把剪贴板里的图片钉住；剪贴板没有图片时 reject 中文原因。 */
export function pinClipboard(): Promise<void> {
  return invoke<void>(desk("pin_clipboard"));
}

/** 从截图历史钉住一张截图。 */
export function pinCapture(id: string): Promise<void> {
  return invoke<void>(desk("pin_capture"), { id });
}

export function pinInfo(pin: string): Promise<PinInfo | null> {
  return invoke<PinInfo | null>(desk("pin_info"), { pin });
}

/** 钉图窗口：第一帧已画好，可以显示了。 */
export function pinReady(pin: string): Promise<void> {
  return invoke<void>(desk("pin_ready"), { pin });
}

/** 在钉图上弹出右键菜单。 */
export function pinMenu(pin: string): Promise<void> {
  return invoke<void>(desk("pin_menu"), { pin });
}

/** 数位笔与触摸拖动钉图：移到屏幕物理像素 (x, y)。 */
export function movePin(pin: string, x: number, y: number): Promise<void> {
  return invoke<void>(desk("move_pin"), { pin, x, y });
}

export function captureHistory(): Promise<CaptureEntry[]> {
  return invoke<CaptureEntry[]>(desk("capture_history"));
}

/** 收藏：经资料库的普通导入入口存进当前资料库。 */
export function collectCapture(id: string): Promise<CollectedCapture> {
  return invoke<CollectedCapture>(desk("collect_capture"), { id });
}

export function deleteCapture(id: string): Promise<void> {
  return invoke<void>(desk("delete_capture"), { id });
}

export function onCaptureHistory(handler: (entries: CaptureEntry[]) => void): Promise<UnlistenFn> {
  return listen<CaptureEntry[]>("capture-history", (e) => handler(e.payload));
}

/** 发给本钉图窗口的提示（例如“已收藏到…”）。只收发给这个窗口的，不收别的钉图的。 */
export function onPinNotice(handler: (text: string) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<string>("pin-notice", (e) => handler(e.payload));
}

/** 截图历史中的截图或冻结屏幕（自定义协议 capture）转成 <img> 可用的 URL。 */
export function captureUrl(address: string): string {
  return convertFileSrc("", "capture") + address;
}
