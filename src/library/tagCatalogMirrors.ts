import type { LegacyNameDecision } from "../bindings/LegacyNameDecision";
import type { LegacyNameMigrationPreview } from "../bindings/LegacyNameMigrationPreview";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import {
  inspectTagCatalog,
  isErrorCode,
  onLibraryEvent,
  onSafeModeSetting,
  onWorkspaceChanged,
  planLegacyNames,
  previewLegacyNames,
} from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";

const TAG_CATALOG_KEY = "tag-catalog";

const stopAll = (listeners: Promise<() => void>[]) =>
  Promise.all(listeners).then((stops) => () => {
    for (const stop of stops) stop();
  });

let catalogReads = 0;
let catalogReread = false;

function finishCatalogRead() {
  catalogReads--;
  if (catalogReads > 0 || !catalogReread) return;
  catalogReread = false;
  tagCatalogMirror.invalidate(TAG_CATALOG_KEY);
}

/** 目录检查很重：读取在途时事件与手动重读只记 dirty，结束后补读一次，不把请求堆进后端。 */
function requestTagCatalogRead() {
  if (catalogReads > 0) {
    catalogReread = true;
    return;
  }
  tagCatalogMirror.invalidate(TAG_CATALOG_KEY);
}

/** 统一标签目录的共享后端镜像（#793）：设置、重名提示与标签对应检查共用读取、事件订阅与防乱序。 */
const tagCatalogMirror = createBackendMirror<typeof TAG_CATALOG_KEY, TagCatalogWorkspace>({
  read: async () => {
    catalogReads++;
    try {
      return await inspectTagCatalog();
    } finally {
      finishCatalogRead();
    }
  },
  stale: (error) => isErrorCode(error, "tagMappingSafeModeChanged"),
  listen: () =>
    stopAll([
      onLibraryEvent((event) => {
        if (event.kind === "vocabularyChanged") requestTagCatalogRead();
      }),
      onSafeModeSetting(() => requestTagCatalogRead()),
    ]),
});

export function useTagCatalog(enabled = true) {
  return useBackendMirror(tagCatalogMirror, TAG_CATALOG_KEY, enabled);
}

export function acceptTagCatalog(next: TagCatalogWorkspace) {
  tagCatalogMirror.accept(TAG_CATALOG_KEY, next);
}

export function invalidateTagCatalog() {
  requestTagCatalogRead();
}

const LEGACY_NAMES_KEY = "legacy-names-plan";
/** 词表连续变化时，两次旧名称检查之间至少隔开这么久（#142）。 */
export const REREAD_DELAY_MS = 200;

type LegacyReread = {
  stale: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  invalidate: () => void;
};

let legacyReads = 0;
let currentLegacyReread: LegacyReread | null = null;

function runLegacyReread(reread: LegacyReread) {
  if (currentLegacyReread !== reread) return;
  reread.timer = undefined;
  if (!reread.stale) return;
  // 自动打标会连续写词表：在途读取结束后再等 200ms 补读一次，不把请求堆进后端。
  if (legacyReads > 0) return;
  reread.stale = false;
  reread.invalidate();
}

function scheduleLegacyReread(reread: LegacyReread) {
  if (currentLegacyReread !== reread) return;
  reread.stale = true;
  if (legacyReads === 0 && reread.timer === undefined) {
    reread.timer = setTimeout(() => runLegacyReread(reread), REREAD_DELAY_MS);
  }
}

function legacyReadFinished() {
  legacyReads--;
  const reread = currentLegacyReread;
  if (reread?.stale && reread.timer === undefined) {
    reread.timer = setTimeout(() => runLegacyReread(reread), REREAD_DELAY_MS);
  }
}

function clearReread(reread: LegacyReread) {
  reread.stale = false;
  clearTimeout(reread.timer);
  reread.timer = undefined;
}

function clearLegacyReread() {
  if (currentLegacyReread) clearReread(currentLegacyReread);
}

/** 名称来源待处理计划的共享后端镜像：主窗口通知与设置入口只读同一份计划。 */
export const legacyNamesMirror = createBackendMirror<typeof LEGACY_NAMES_KEY, LegacyNameMigrationWorkspace>({
  read: async () => {
    legacyReads++;
    try {
      return await planLegacyNames();
    } finally {
      legacyReadFinished();
    }
  },
  stale: (error) => isErrorCode(error, "nameMigrationSafeModeChanged"),
  listen: (invalidate) => {
    const reread: LegacyReread = { stale: false, timer: undefined, invalidate: () => invalidate(LEGACY_NAMES_KEY) };
    currentLegacyReread = reread;
    // 待确认的旧名称合计所有资料库：登记或可用状态变了才重读；只是修订前进（每次写入都有）不读。
    let registrations: string | null = null;
    return stopAll([
      onLibraryEvent((event) => {
        if (event.kind === "vocabularyChanged" || event.kind === "taskFinished") scheduleLegacyReread(reread);
      }),
      onSafeModeSetting(() => scheduleLegacyReread(reread)),
      onWorkspaceChanged((status) => {
        const next = status.libraries
          .map((entry) => `${entry.library.id}:${entry.unavailable ? 0 : 1}`)
          .sort()
          .join("|");
        if (next === registrations) return;
        registrations = next;
        scheduleLegacyReread(reread);
      }),
    ]).then((stop) => () => {
      clearReread(reread);
      if (currentLegacyReread === reread) currentLegacyReread = null;
      stop();
    });
  },
});

export function useLegacyNamesPlan(enabled = true) {
  return useBackendMirror(legacyNamesMirror, LEGACY_NAMES_KEY, enabled);
}

export function acceptLegacyNamesPlan(next: LegacyNameMigrationWorkspace) {
  clearLegacyReread();
  legacyNamesMirror.accept(LEGACY_NAMES_KEY, next);
}

export function invalidateLegacyNamesPlan() {
  clearLegacyReread();
  legacyNamesMirror.invalidate(LEGACY_NAMES_KEY);
}

/** 向导确认前的预览按修订与整套选择建键；选择一变就是另一个查询，迟到的旧预览自然不能交付。 */
const legacyNamesPreviewMirror = createBackendMirror<string, LegacyNameMigrationPreview>({
  read: (key) => {
    const [revision, decisions] = JSON.parse(key) as [number, LegacyNameDecision[]];
    return previewLegacyNames(revision, decisions);
  },
});

export function useLegacyNamesPreview(revision: number, decisions: LegacyNameDecision[], enabled = true) {
  return useBackendMirror(legacyNamesPreviewMirror, JSON.stringify([revision, decisions]), enabled);
}
