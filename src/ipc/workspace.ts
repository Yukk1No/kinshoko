import type { SaveDestination } from "../bindings/SaveDestination";
import type { ImportTaskSnapshot } from "../bindings/ImportTaskSnapshot";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { LegacyNameMigrationPreview } from "../bindings/LegacyNameMigrationPreview";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import type { LegacyNameDecision } from "../bindings/LegacyNameDecision";
import type { WorkspaceQuery } from "../bindings/WorkspaceQuery";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import type { CatalogNameEdit } from "../bindings/CatalogNameEdit";
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CatalogCorrection } from "../bindings/CatalogCorrection";
import type { CatalogImageTags } from "../bindings/CatalogImageTags";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import type { Candidate } from "../bindings/Candidate";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageEdit } from "../bindings/ImageEdit";
import type { PermanentDeletePreview } from "../bindings/PermanentDeletePreview";
import type { ReferenceGroup } from "../bindings/ReferenceGroup";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { Sidebar } from "../bindings/Sidebar";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { TagGroupView } from "../bindings/TagGroupView";
import { lib, desk } from "./plugins";

/** Inspect registered content providers and durable application-level tag mappings. */
export function inspectTagCatalog(): Promise<TagCatalogWorkspace> {
  return invoke<TagCatalogWorkspace>(lib("inspect_tag_catalog"));
}

export function correctTagMapping(libraryId: string, localTagId: string, correction: CatalogCorrection): Promise<TagCatalogWorkspace> {
  return invoke<TagCatalogWorkspace>(lib("correct_tag_mapping"), { libraryId, localTagId, correction });
}

export function publishTagDefinitions(libraryId: string): Promise<TagCatalogWorkspace> {
  return invoke<TagCatalogWorkspace>(lib("publish_tag_definitions"), { libraryId });
}

export function catalogImageTags(libraryId: string, imageId: string, lang: string): Promise<CatalogImageTags> {
  return invoke<CatalogImageTags>(lib("catalog_image_tags"), { libraryId, imageId, lang });
}

/** Application workspace queries. These never switch an active library or write destination. */
export function workspaceBrowse(query: WorkspaceQuery, safeMode: boolean): Promise<WorkspacePage> {
  return invoke<WorkspacePage>(lib("workspace_browse"), { query, safeMode });
}
export function workspaceStatus(safeMode: boolean): Promise<WorkspaceStatus> {
  return invoke<WorkspaceStatus>(lib("workspace_status"), { safeMode });
}
export function workspaceResolve(input: SearchInput, lang: string, safeMode: boolean): Promise<ConditionTree> {
  return invoke<ConditionTree>(lib("workspace_resolve"), { input, lang, safeMode });
}
export function workspaceCandidates(text: string, lang: string, limit: number, safeMode: boolean): Promise<Candidate[]> {
  return invoke<Candidate[]>(lib("workspace_candidates"), { text, lang, limit, safeMode });
}
export function workspaceImage(libraryId: string, imageId: string): Promise<ImageDetail> {
  return invoke<ImageDetail>(lib("workspace_image"), { libraryId, imageId });
}
/** 一张图的卡片，与图片墙同样构成（id 是字节身份、带全部来源）；不经图片墙打开的入口用。 */
export function workspaceCard(libraryId: string, imageId: string, safeMode: boolean): Promise<WorkspaceCard> {
  return invoke<WorkspaceCard>(lib("workspace_card"), { libraryId, imageId, safeMode });
}
export function workspaceSidebar(libraryId: string, safeMode: boolean): Promise<Sidebar> {
  return invoke<Sidebar>(lib("workspace_sidebar"), { libraryId, safeMode });
}
export function workspaceTagGroups(libraryId: string, lang: string, safeMode: boolean): Promise<TagGroupView[]> {
  return invoke<TagGroupView[]>(lib("workspace_tag_groups"), { libraryId, lang, safeMode });
}
export function workspaceLocalTags(libraryId: string, ids: string[], safeMode: boolean): Promise<string[]> {
  return invoke<string[]>(lib("workspace_local_tags"), { libraryId, ids, safeMode });
}
export function onWorkspaceChanged(handler: (status: WorkspaceStatus) => void): Promise<UnlistenFn> {
  return listen<WorkspaceStatus>("workspace-changed", (event) => handler(event.payload));
}

export function editTagName(catalogId: string, edit: CatalogNameEdit): Promise<TagCatalogWorkspace> {
  return invoke<TagCatalogWorkspace>(lib("edit_tag_name"), { catalogId, edit });
}


// Explicit aggregate-source actions keep browsing and the current library independent.
export function workspaceSourceInspection(target: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, lang: string): Promise<import("../bindings/WorkspaceSourceInspection").WorkspaceSourceInspection> {
  return invoke(lib("workspace_source_inspection"), { target, safeMode, lang });
}
export function workspaceEditSource(target: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, edits: ImageEdit[]): Promise<void> {
  return invoke(lib("workspace_edit_source"), { target, safeMode, edits });
}
/** 跨图库的多份来源一次整理（#290）：后端按图库分组，每个图库只切一次可写句柄；返回没完成的图库与原因。 */
export function workspaceEditSources(targets: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget[], safeMode: boolean, edits: ImageEdit[]): Promise<import("../bindings/LibraryBatchFailure").LibraryBatchFailure[]> {
  return invoke(lib("workspace_edit_sources"), { targets, safeMode, edits });
}
export function workspaceEditSourceTags(target: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, edits: TagEdit[]): Promise<void> {
  return invoke(lib("workspace_edit_source_tags"), { target, safeMode, edits });
}
export function workspaceSourceCandidates(target: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, text: string, lang: string, safeMode: boolean): Promise<Candidate[]> {
  return invoke(lib("workspace_source_candidates"), { target, text, lang, safeMode });
}

export function workspaceSourceGroup(target: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, choice: { groupId: string; name?: never } | { name: string; groupId?: never }): Promise<ReferenceGroup> {
  return invoke(lib("workspace_source_group"), { target, safeMode, groupId: choice.groupId ?? null, name: choice.name ?? null });
}

export function workspacePreviewSourceDelete(target: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean): Promise<PermanentDeletePreview> {
  return invoke(lib("workspace_preview_source_delete"), { target, safeMode });
}
export function workspacePermanentSourceDelete(target: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, token: string): Promise<void> {
  return invoke(lib("workspace_permanent_source_delete"), { target, safeMode, token });
}

export function workspaceDirectories(safeMode: boolean): Promise<WorkspaceDirectories> {
  return invoke<WorkspaceDirectories>(lib("workspace_directories"), { safeMode });
}

/** Unknown legacy names: read a safe-mode-filtered plan; confirm all choices atomically. */
export function planLegacyNames(): Promise<LegacyNameMigrationWorkspace> {
  return invoke<LegacyNameMigrationWorkspace>(lib("plan_legacy_names"));
}
export function confirmLegacyNames(revision: number, decisions: LegacyNameDecision[]): Promise<LegacyNameMigrationWorkspace> {
  return invoke<LegacyNameMigrationWorkspace>(lib("confirm_legacy_names"), { revision, decisions });
}

export function previewLegacyNames(revision: number, decisions: LegacyNameDecision[]): Promise<LegacyNameMigrationPreview> {
  return invoke<LegacyNameMigrationPreview>(lib("preview_legacy_names"), { revision, decisions });
}

export function importTasks(): Promise<ImportTaskSnapshot[]> { return invoke<ImportTaskSnapshot[]>(lib("import_tasks")); }
export function dismissImport(libraryId:string,taskId:string): Promise<void> { return invoke<void>(lib("dismiss_import"),{libraryId,taskId}); }

export function takeCollectionRequest(): Promise<string|null> { return invoke<string|null>(desk("take_collection_request")); }
export function onCollectionRequest(handler:()=>void): Promise<UnlistenFn> { return listen("capture-collection-request",handler); }
export function workspaceCopySource(target:import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget,destination:SaveDestination,safeMode:boolean): Promise<string> { return invoke<string>(lib("workspace_copy_source"),{target,destination,safeMode}); }
/** Application groups are independent of the active provider; counts use all-source safety. */
export function sharedTagGroups(lang: string, safeMode: boolean): Promise<CatalogGroupView[]> {
  return invoke<CatalogGroupView[]>(lib("shared_tag_groups"), { lang, safeMode });
}
export function createSharedTagGroup(name: string, namespace: TagNamespace | null): Promise<string> {
  return invoke<string>(lib("create_shared_tag_group"), { name, namespace });
}
export function editSharedTagGroup(edit: CatalogGroupEdit, safeMode: boolean): Promise<void> {
  return invoke<void>(lib("edit_shared_tag_group"), { edit, safeMode });
}


/** Application-wide personal judgments; labels obey every known provider's safe-mode veto. */
export function sharedPersonalApprox(lang: string, safeMode: boolean) {
  return invoke<import("../bindings/CatalogApproxView").CatalogApproxView>(lib("shared_personal_approx"), { lang, safeMode });
}
export function editSharedApprox(edit: import("../bindings/CatalogApproxEdit").CatalogApproxEdit, safeMode: boolean) {
  return invoke<void>(lib("edit_shared_approx"), { edit, safeMode });
}

/** Reply only to this native capture request; delayed replies cannot replace a newer frame. */
export function reportCaptureReferences(request: string, frame: import("../bindings/CaptureReferenceFrame").CaptureReferenceFrame): Promise<void> {
  return invoke<void>(desk("report_capture_references"), { request, frame });
}

/** Consent only to the backend-owned receipt; arbitrary image IDs are never accepted. */
export function openImportPreview(libraryId: string, taskId: string): Promise<import("../bindings/ImportPreviewSession").ImportPreviewSession> {
  return invoke(lib("open_import_preview"), { libraryId, taskId });
}
export function closeImportPreview(sessionId: string | null): Promise<void> {
  return invoke(lib("close_import_preview"), { sessionId });
}
export async function readImportPreview(sessionId: string, itemId: string, targetPx = 640): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    let chunks: Uint8Array<ArrayBuffer>[] = [], done = false, acknowledged = false, settled = false;
    const finish = () => {
      if (!done || !acknowledged || settled) return;
      settled = true;
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      chunks = []; resolve(bytes);
    };
    const onChunk = new Channel<ArrayBuffer | number[]>(raw => {
      if (settled) return;
      const chunk = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
      if (chunk.byteLength === 0) done = true; else chunks.push(chunk);
      finish();
    });
    void invoke<void>(lib("read_import_preview"), { sessionId, itemId, targetPx, onChunk }).then(() => {
      acknowledged = true; finish();
    }, error => { settled = true; chunks = []; reject(error); });
  });
}
// ---------- 程序设置备份（#78 T13）；与资料库内容备份分开 ----------
export function pickApplicationSettings(save: boolean): Promise<string | null> { return invoke<string | null>(lib("pick_application_settings"), { save }); }
export function exportApplicationSettings(path: string): Promise<void> { return invoke<void>(lib("export_application_settings"), { path }); }
export function previewApplicationSettings(path: string): Promise<import("../bindings/ApplicationSettingsPreview").ApplicationSettingsPreview> { return invoke(lib("preview_application_settings"), { path }); }
export function restoreApplicationSettings(path: string, fingerprint: string): Promise<import("../bindings/ApplicationSettingsRestored").ApplicationSettingsRestored> { return invoke(lib("restore_application_settings"), { path, fingerprint }); }
export function setViewerBackground(background: import("../bindings/ViewerBackground").ViewerBackground): Promise<ShellSettingsView> { return invoke("set_viewer_background", { background }); }
/** 保存主窗口详情面板的宽度（#157）；后端把它收进 280–560。 */
export function setInspectorWidth(width: number): Promise<ShellSettingsView> { return invoke("set_inspector_width", { width }); }
export function migrateViewerBackground(background: import("../bindings/ViewerBackground").ViewerBackground): Promise<ShellSettingsView> { return invoke("migrate_viewer_background", { background }); }
