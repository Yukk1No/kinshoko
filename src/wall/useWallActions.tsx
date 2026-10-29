import { useRef, useState, type ReactNode } from "react";
import type { ScreenRect } from "../bindings/ScreenRect";
import type { WorkspaceSourceTarget } from "../bindings/WorkspaceSourceTarget";
import { clipboardHasImage, copyReferenceImage, pinReference, referenceGroups, revealReferenceImage, workspaceEditSources, workspaceImage, workspaceSidebar, workspaceSourceGroup } from "../ipc";
import { flattenFolders, PermanentDeleteConfirm } from "../library/SelectionPanel";
import { libraryFailures, PermanentDeleteBatchConfirm } from "../library/PermanentDeleteBatch";
import type { BrowserCard } from "./Wall";
import type { ImportSource, WallMenuActions } from "./WallMenu";
import { useToast } from "../ui/Toast";

/** 一次最多钉住的张数；超过时只钉前这么多张，再用轻提示说明。 */
export const PIN_LIMIT = 20;
/** 多张钉图依次错开的距离（CSS 像素）。 */
const PIN_STAGGER = 28;

type Point = { x: number; y: number };

/**
 * 多张钉图的位置：从指针位置起，每张向右下错开一点。钉图以给出的矩形中心出现，
 * 所以这里只给中心（窗口客户区的物理像素，与查看器钉图同一坐标）。
 */
export function staggeredPins(point: Point, count: number, dpr: number): ScreenRect[] {
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round((point.x + i * PIN_STAGGER) * dpr) - 1,
    y: Math.round((point.y + i * PIN_STAGGER) * dpr) - 1,
    width: 2,
    height: 2,
  }));
}

/** 卡片显示的那份来源。 */
const targetOf = (card: BrowserCard, fallbackLibrary: string): WorkspaceSourceTarget => ({
  libraryId: card.libraryId ?? fallbackLibrary, imageId: card.imageId ?? card.id, contentId: card.id,
});

/** 整理这份来源后卡片还在当前视图里：别的来源仍符合这个视图（例如另一个资料库里那份没进回收站）。 */
const staysAfter = (card: BrowserCard, target: WorkspaceSourceTarget) =>
  (card.sources ?? []).some((s) => s.matches && !(s.libraryId === target.libraryId && s.imageId === target.imageId));

export type WallActionsOptions = {
  safe: boolean;
  /** 卡片没有标出图库时的后备图库。 */
  activeLibraryId: string;
  onOpen: (card: BrowserCard) => void;
  onCrop: (card: BrowserCard) => void;
  onInspect: (card: BrowserCard) => void;
  /** 整理写入后：重新浏览并刷新词表。 */
  onChanged: () => void;
  /** 先把卡片从墙上移走（#290）；返回结束函数，后端做完后带上没做成的卡片调用（全部做成时为空）。 */
  removeCards?: (cards: BrowserCard[]) => (failed: BrowserCard[]) => void;
  onClearSelection: () => void;
  onError: (message: string) => void;
  /** 成功的轻提示（例如“已复制图片”）。 */
  onNotice: (message: string) => void;
  importFrom: (source: ImportSource) => void;
  /** 从剪贴板导入的入口（导入菜单）；剪贴板没有图片等原因以 reject 给出。 */
  importClipboard: () => Promise<void>;
  selectAll: () => void;
  setDensity: (value: number) => void;
};

/**
 * 图片墙右键菜单与快捷键背后的动作：钉住（最多 20 张，超过只钉前 20 张）、按来源整理（移到回收站后可撤销）、加入参考组、
 * 彻底删除（先确认受影响的参考组）、复制图片、在资源管理器中显示与从剪贴板导入（#105）。
 * dialogs 由调用方放进界面。
 */
export function useWallActions(o: WallActionsOptions): { actions: WallMenuActions; dialogs: ReactNode } {
  const options = useRef(o);
  options.current = o;
  const toast = useToast();
  const [purging, setPurging] = useState<BrowserCard[] | null>(null);

  const pinNow = async (cards: BrowserCard[], point: Point) => {
    const { activeLibraryId, onError } = options.current;
    const rects = staggeredPins(point, cards.length, window.devicePixelRatio || 1);
    // 依次钉住：后钉的盖在先钉的上面，错开的顺序与图片墙一致。
    for (const [i, card] of cards.entries()) {
      const target = targetOf(card, activeLibraryId);
      try { await pinReference(target.libraryId, target.imageId, null, rects[i]); } catch (e) { onError(`无法钉住：${String(e)}`); return false; }
    }
    return true;
  };

  /** 卡片来源里写着的图库名；没有时用 id。 */
  const libraryName = (libraryId: string) =>
    cardsNamed.current.flatMap((card) => card.sources ?? []).find((source) => source.libraryId === libraryId)?.libraryName ?? libraryId;
  const cardsNamed = useRef<BrowserCard[]>([]);
  /**
   * 加入参考组跨图库逐张执行（ADR-0008；整理走一次批量命令，见 `edit`）：后端按需把可写句柄切到每张图的图库；一个图库失败（断连等）时
   * 其他图库照常完成，最后按图库报告没完成的原因。按图库分组依次做（按图库第一次出现的顺序）：
   * 可写句柄每个图库只切一次；一个图库失败（例如导入一直没收尾、等到上限）后跳过它剩下的图，
   * 不让每张图各等一次上限，其他图库也不必跟着等。
   */
  const eachCard = async (cards: BrowserCard[], what: string, run: (target: WorkspaceSourceTarget) => Promise<unknown>) => {
    cardsNamed.current = cards;
    const byLibrary = new Map<string, { card: BrowserCard; target: WorkspaceSourceTarget }[]>();
    for (const card of cards) {
      const target = targetOf(card, options.current.activeLibraryId);
      const group = byLibrary.get(target.libraryId);
      if (group) group.push({ card, target }); else byLibrary.set(target.libraryId, [{ card, target }]);
    }
    const failed: { libraryId: string; error: string }[] = [];
    /** 已完成的图：有图库失败时，撤销只作用于这些。 */
    const succeeded: BrowserCard[] = [];
    for (const [libraryId, entries] of byLibrary) {
      for (const { card, target } of entries) {
        try { await run(target); succeeded.push(card); } catch (e) { failed.push({ libraryId, error: String(e) }); break; }
      }
    }
    if (failed.length) options.current.onError(`有图库没有${what}。${libraryFailures(failed, libraryName)}`);
    return { ok: failed.length === 0, succeeded };
  };

  const actions: WallMenuActions = {
    open: (card) => options.current.onOpen(card),
    crop: (card) => options.current.onCrop(card),
    inspectSources: (card) => options.current.onInspect(card),
    importFrom: (source) => options.current.importFrom(source),
    selectAll: () => options.current.selectAll(),
    setDensity: (value) => options.current.setDensity(value),
    copy(card) {
      const { activeLibraryId, onNotice, onError } = options.current;
      const target = targetOf(card, activeLibraryId);
      copyReferenceImage(target.libraryId, target.imageId).then(() => onNotice("已复制图片"), (e) => onError(`无法复制图片：${String(e)}`));
    },
    reveal(card) {
      const { activeLibraryId, onError } = options.current;
      const target = targetOf(card, activeLibraryId);
      revealReferenceImage(target.libraryId, target.imageId).catch((e) => onError(`无法在资源管理器中显示：${String(e)}`));
    },
    importClipboard() {
      const { importClipboard, onError } = options.current;
      importClipboard().catch((e) => onError(String(e)));
    },
    clipboardHasImage: () => clipboardHasImage(),
    pin(cards, point) {
      if (cards.length <= PIN_LIMIT) { void pinNow(cards, point); return; }
      // 超过上限不弹确认：钉住前 PIN_LIMIT 张，再告诉画师只钉了这么多。
      void pinNow(cards.slice(0, PIN_LIMIT), point).then((ok) => {
        if (ok) toast?.show({ title: `已钉住前 ${PIN_LIMIT} 张`, description: `一次最多钉住 ${PIN_LIMIT} 张`, tone: "success" });
      });
    },
    edit(cards, edits, clear) {
      const { safe, activeLibraryId, onChanged, onClearSelection, onError, removeCards } = options.current;
      cardsNamed.current = cards;
      const entries = cards.map((card) => ({ card, target: targetOf(card, activeLibraryId) }));
      // 移到回收站与还原让卡片离开当前视图：先移走，不等后端与整墙重读（#290）。别的来源还让它留在视图里的卡片不动。
      const leaving = edits.length === 1 && (edits[0].kind === "delete" || edits[0].kind === "restore");
      const moved = leaving ? entries.filter(({ card, target }) => !staysAfter(card, target)).map(({ card }) => card) : [];
      const putBack = moved.length ? removeCards?.(moved) : undefined;
      void (async () => {
        try {
          // 一次调用：后端按图库分组，每个图库只切一次可写句柄、整理一次；一个图库失败不影响其他图库（ADR-0008）。
          let failed: { libraryId: string; error: string }[];
          try {
            failed = await workspaceEditSources(entries.map(({ target }) => target), safe, edits);
          } catch (e) {
            putBack?.(moved);
            onError(`没有整理完：${String(e)}`);
            return;
          }
          const failedLibraries = new Set(failed.map((f) => f.libraryId));
          const succeeded = entries.filter(({ target }) => !failedLibraries.has(target.libraryId)).map(({ card }) => card);
          putBack?.(moved.filter((card) => !succeeded.includes(card)));
          if (failed.length) {
            onError(`有图库没有整理完。${libraryFailures(failed, libraryName)}`);
          }
          if (!failed.length && clear) onClearSelection();
          // 移到回收站能撤销，所以不先确认：直接做，再给一个带“撤销”的轻提示。有图库失败时，已移走的那部分照样能撤销。
          if (succeeded.length > 0 && edits.length === 1 && edits[0].kind === "delete") {
            toast?.show({
              title: "已移到回收站", description: succeeded.length > 1 ? `${succeeded.length} 张` : undefined, tone: "success",
              action: { label: "撤销", onClick: () => actions.edit(succeeded, [{ kind: "restore" }], false) },
            });
          }
        } finally {
          onChanged();
        }
      })();
    },
    addToGroup(cards, groupId) {
      const { safe } = options.current;
      void eachCard(cards, "加入参考组", (target) => workspaceSourceGroup(target, safe, { groupId }));
    },
    purge(cards) {
      // 多张可以跨图库（ADR-0008）：后端按图库分组，逐组切换可写句柄删除。
      cardsNamed.current = cards;
      setPurging(cards);
    },
    inFolder: (card, folderId) => {
      const target = targetOf(card, options.current.activeLibraryId);
      return workspaceImage(target.libraryId, target.imageId).then((detail) => detail.folders.some((folder) => folder.id === folderId));
    },
    folders: (libraryId) => workspaceSidebar(libraryId, options.current.safe).then((sidebar) => flattenFolders(sidebar.folders)),
    groups: () => referenceGroups(),
  };

  const purgeTarget = purging?.length === 1 ? targetOf(purging[0], o.activeLibraryId) : undefined;
  const purged = () => { setPurging(null); options.current.onClearSelection(); options.current.onChanged(); };
  const dialogs = <>
    {purging && purgeTarget && <PermanentDeleteConfirm
      libraryId={purgeTarget.libraryId}
      ids={[purgeTarget.imageId]}
      sourceTarget={purgeTarget}
      safeMode={o.safe}
      onDone={purged}
      onCancel={() => setPurging(null)}
      onError={(message) => options.current.onError(message)}
    />}
    {purging && !purgeTarget && <PermanentDeleteBatchConfirm
      targets={purging.map((card) => {
        const { libraryId, imageId } = targetOf(card, o.activeLibraryId);
        return { libraryId, imageId };
      })}
      libraryName={libraryName}
      onDone={purged}
      onCancel={() => setPurging(null)}
      onError={(message) => options.current.onError(message)}
    />}
  </>;
  return { actions, dialogs };
}
