import type { RuntimeCapabilities } from "../bindings/RuntimeCapabilities";
import type { RuntimeStatus } from "../bindings/RuntimeStatus";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BackupPreview } from "../bindings/BackupPreview";
import type { BackupStatus } from "../bindings/BackupStatus";
import type { RestoreReport } from "../bindings/RestoreReport";
import type { ScopeSelection } from "../bindings/ScopeSelection";
import type { SnapshotSummary } from "../bindings/SnapshotSummary";
import type { ModelChoice } from "../bindings/ModelChoice";
import type { Device } from "../bindings/Device";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { ShortcutAction } from "../bindings/ShortcutAction";
import type { LibraryTaggingStatus } from "../bindings/LibraryTaggingStatus";
import type { UpdateProgress } from "../bindings/UpdateProgress";
import type { UpdateChannel } from "../bindings/UpdateChannel";
import type { UpdateStatus } from "../bindings/UpdateStatus";
import { testPick } from "./plugins";

/** 自动标签的当前状态；还没打开资料库时 reject。 */
export function taggingStatus(libraryId: string): Promise<LibraryTaggingStatus> {
  return invoke<LibraryTaggingStatus>("tagging_status", { libraryId });
}

/** 画师确认后下载打标模型（可续传）。 */
export function taggingDownload(libraryId: string): Promise<void> {
  return invoke<void>("tagging_download", { libraryId });
}

/** 暂停打标：结束打标子进程，归还显存。 */
export function taggingPause(libraryId: string): Promise<void> {
  return invoke<void>("tagging_pause", { libraryId });
}

export function taggingResume(libraryId: string): Promise<void> {
  return invoke<void>("tagging_resume", { libraryId });
}

/** 设置中的打标模型名称、各硬件档的需求与是否已下载，以及画师选的硬件档。 */
export function taggingModels(): Promise<ModelChoice> {
  return invoke<ModelChoice>("tagging_models");
}

/** 换用硬件档（`null` 为自动），保存在本设备。 */
export function taggingSetDevice(device: Device | null): Promise<ModelChoice> {
  return invoke<ModelChoice>("tagging_set_device", { device });
}

/** 选择要导入的模型包（zip）；取消时为 null。 */
export function pickModelPackage(): Promise<string | null> {
  const t = testPick<string | null>();
  return t ? Promise.resolve(t.value) : invoke<string | null>("tagging_pick_package");
}

/** 从文件导入模型包并校验；校验不过时 reject 中文原因。 */
export function importModelPackage(path: string): Promise<ModelChoice> {
  return invoke<ModelChoice>("tagging_import_package", { path });
}

export function onTaggingStatus(handler: (status: LibraryTaggingStatus) => void): Promise<UnlistenFn> {
  return listen<LibraryTaggingStatus>("tagging-status", (e) => handler(e.payload));
}

/** 应用壳设置：开机自启与全局快捷键。 */
export function shellSettings(): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("shell_settings");
}

/** 开关开机自启。失败时 reject 一条给画师看的中文原因。 */
export function setAutostart(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_autostart", { on });
}

/** 开关查找条件里相近标签的来源标记（内置／个人）。 */
export function setShowApproxSource(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_show_approx_source", { on });
}

/** 保存标签外观与可信度分档（#160）；阈值交叉时 reject 中文原因，原来的设置不变。 */
export function setTagDisplay(display: import("../bindings/TagDisplay").TagDisplay): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_tag_display", { display });
}

/** 更换全局快捷键，立即生效；`null` 表示清除。失败时 reject 中文原因，原来的键不变。 */
export function rebindShortcut(
  action: ShortcutAction,
  accelerator: string | null,
): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("rebind_shortcut", { action, accelerator });
}

/** 诊断开关“强制 sRGB”：保存后重启 Kinshoko 生效。 */
/** 切换安全模式时是否保留当前选择和详情面板。 */
export function setKeepSelectionOnSafeMode(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_keep_selection_on_safe_mode", { on });
}

export function setForceSrgb(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_force_srgb", { on });
}

/** 开关使用日志（只写本机），立即生效。 */
export function setUsageLog(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_usage_log", { on });
}

/** 本机的界面缩放档位（百分比，#173）。只存本机，不进程序设置备份。 */
export function uiScale(): Promise<number> {
  return invoke<number>("ui_scale");
}

/** 换一档界面缩放，主窗口立即缩放；返回保存后的档位。 */
export function setUiScale(percent: number): Promise<number> {
  return invoke<number>("set_ui_scale", { percent });
}

/** 系统的双击间隔（毫秒）与以第一下为中心的判定矩形（物理像素，#179）。 */
export type DoubleClickSettings = { intervalMs: number; width: number; height: number };

/** 读系统的双击设置；读不到（或不是 Windows）时为 null。 */
export function doubleClick(): Promise<DoubleClickSettings | null> {
  return invoke<DoubleClickSettings | null>("double_click");
}

// ---------- 诊断与更新（#70） ----------

/** 诊断日志全文：硬件、系统、WebView2 与显示器色彩状态，不含文件名、路径与图片。 */
export function diagnosticsReport(runtime?: RuntimeCapabilities): Promise<string> {
  return invoke<string>("diagnostics_report", { runtime });
}

/** 把诊断日志存成文件；画师取消时为 false。 */
export function exportDiagnostics(runtime?: RuntimeCapabilities): Promise<boolean> {
  return invoke<boolean>("export_diagnostics", { runtime });
}

/** 当前窗口实际渲染能力的解释；不根据 Runtime 版本猜测。 */
export function runtimeStatus(runtime: RuntimeCapabilities): Promise<RuntimeStatus> {
  return invoke("runtime_status", { runtime });
}

/** 只打开固定的微软 WebView2 下载页，不下载或安装运行时。 */
export function openRuntimeUpdate(): Promise<void> {
  return invoke("open_runtime_update");
}

/** 把使用日志导出成文件；画师取消时为 false。 */
export function exportUsageLog(): Promise<boolean> {
  return invoke<boolean>("export_usage_log");
}

/** 删掉已记录的使用日志。 */
export function clearUsageLog(): Promise<void> {
  return invoke<void>("clear_usage_log");
}

/** 上次检查更新的结果。 */
export function updateStatus(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("update_status");
}

// ---------- 本地备份与恢复（#69） ----------

/** 备份计划（目标、范围、上次结果）与正在进行的备份。 */
export function backupStatus(): Promise<BackupStatus> {
  return invoke<BackupStatus>("backup_status");
}

/** 选择备份目标目录；`null` 为清除。 */
export function setBackupTarget(target: string | null): Promise<BackupStatus> {
  return invoke<BackupStatus>("set_backup_target", { target });
}

export function setBackupSelection(selection: ScopeSelection): Promise<BackupStatus> {
  return invoke<BackupStatus>("set_backup_selection", { selection });
}

/** 执行前的范围、未覆盖内容与容量。 */
export function backupPreview(selection: ScopeSelection): Promise<BackupPreview> {
  return invoke<BackupPreview>("backup_preview", { selection });
}

/** 马上备份一次；进度与结果经 `onBackupStatus` 推送。 */
export function startBackup(): Promise<void> {
  return invoke<void>("start_backup");
}

export function backupSnapshots(): Promise<SnapshotSummary[]> {
  return invoke<SnapshotSummary[]>("backup_snapshots");
}

/** 从快照恢复出独立的资料库（放在 `into` 下）与参考组，返回自动运行的往返检查结果。 */
export function restoreBackup(snapshotId: string, into: string): Promise<RestoreReport> {
  return invoke<RestoreReport>("restore_backup", { snapshotId, into });
}

export function onBackupStatus(handler: (status: BackupStatus) => void): Promise<UnlistenFn> {
  return listen<BackupStatus>("backup-status", (e) => handler(e.payload));
}

/** 向 GitHub Releases 检查新版本。 */
export function checkUpdate(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("check_update");
}

/** 换更新通道（#204）：保存选择，作废上一次检查的结果；随后按新通道重新检查。 */
export function setUpdateChannel(channel: UpdateChannel): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_update_channel", { channel });
}

/** 下载并安装新版本；成功时 Kinshoko 退出、装好后重新启动。 */
export function installUpdate(): Promise<void> {
  return invoke<void>("install_update");
}

export function onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update-progress", (e) => handler(e.payload));
}

/** 更新通道换了（#204）：之前查到的更新已作废。 */
export function onUpdateChannelChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("update-channel-changed", () => handler());
}
