import { useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ScreenRect } from "../bindings/ScreenRect";
import type { WorkspaceSourceTarget } from "../bindings/WorkspaceSourceTarget";
import { clipboardHasImage, copyReferenceImage, pinReference, referenceGroups, revealReferenceImage, workspaceEditSource, workspaceImage, workspaceSidebar, workspaceSourceGroup } from "../ipc";
import { flattenFolders, PermanentDeleteConfirm } from "../library/SelectionPanel";
import { libraryFailures, PermanentDeleteBatchConfirm } from "../library/PermanentDeleteBatch";
import type { BrowserCard } from "./Wall";
import type { ImportSource, WallMenuActions } from "./WallMenu";

/** 一次最多钉住的张数；超过时先确认，只钉前这么多张。 */
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

export type WallActionsOptions = {
  safe: boolean;
  /** 卡片没有标出图库时的后备图库。 */
  activeLibraryId: string;
  onOpen: (card: BrowserCard) => void;
  onCrop: (card: BrowserCard) => void;
  onInspect: (card: BrowserCard) => void;
  /** 整理写入后：重新浏览并刷新词表。 */
  onChanged: () => void;
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
 * 图片墙右键菜单与快捷键背后的动作：钉住（最多 20 张，超过先确认）、按来源整理、加入参考组、
 * 彻底删除（先确认受影响的参考组）、复制图片、在资源管理器中显示与从剪贴板导入（#105）。
 * dialogs 由调用方放进界面。
 */
export function useWallActions(o: WallActionsOptions): { actions: WallMenuActions; dialogs: ReactNode } {
  const options = useRef(o);
  options.current = o;
  const [pinMany, setPinMany] = useState<{ cards: BrowserCard[]; point: Point } | null>(null);
  const [purging, setPurging] = useState<BrowserCard[] | null>(null);

  const pinNow = async (cards: BrowserCard[], point: Point) => {
    const { activeLibraryId, onError } = options.current;
    const rects = staggeredPins(point, cards.length, window.devicePixelRatio || 1);
    // 依次钉住：后钉的盖在先钉的上面，错开的顺序与图片墙一致。
    for (const [i, card] of cards.entries()) {
      const target = targetOf(card, activeLibraryId);
      try { await pinReference(target.libraryId, target.imageId, null, rects[i]); } catch (e) { onError(`无法钉住：${String(e)}`); return; }
    }
  };

  /** 卡片来源里写着的图库名；没有时用 id。 */
  const libraryName = (libraryId: string) =>
    cardsNamed.current.flatMap((card) => card.sources ?? []).find((source) => source.libraryId === libraryId)?.libraryName ?? libraryId;
  const cardsNamed = useRef<BrowserCard[]>([]);
  /**
   * 跨图库逐张执行（ADR-0008）：后端按需把可写句柄切到每张图的图库；一个图库失败（断连等）时
   * 其他图库照常完成，最后按图库报告没完成的原因。按图库分组依次做（按图库第一次出现的顺序）：
   * 可写句柄每个图库只切一次；一个图库失败（例如导入一直没收尾、等到上限）后跳过它剩下的图，
   * 不让每张图各等一次上限，其他图库也不必跟着等。
   */
  const eachCard = async (cards: BrowserCard[], what: string, run: (target: WorkspaceSourceTarget) => Promise<unknown>) => {
    cardsNamed.current = cards;
    const byLibrary = new Map<string, WorkspaceSourceTarget[]>();
    for (const card of cards) {
      const target = targetOf(card, options.current.activeLibraryId);
      const group = byLibrary.get(target.libraryId);
      if (group) group.push(target); else byLibrary.set(target.libraryId, [target]);
    }
    const failed: { libraryId: string; error: string }[] = [];
    for (const [libraryId, targets] of byLibrary) {
      for (const target of targets) {
        try { await run(target); } catch (e) { failed.push({ libraryId, error: String(e) }); break; }
      }
    }
    if (failed.length) options.current.onError(`有图库没有${what}。${libraryFailures(failed, libraryName)}`);
    return failed.length === 0;
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
      if (cards.length > PIN_LIMIT) setPinMany({ cards, point });
      else void pinNow(cards, point);
    },
    edit(cards, edits, clear) {
      const { safe, onChanged, onClearSelection } = options.current;
      void (async () => {
        try {
          if (await eachCard(cards, "整理完", (target) => workspaceEditSource(target, safe, edits)) && clear) onClearSelection();
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
    {pinMany && <AlertDialog.Root open onOpenChange={(open) => { if (!open) setPinMany(null); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="k-backdrop" />
        <AlertDialog.Popup className="k-dialog is-alert" aria-label="钉住多张">
          <AlertDialog.Title className="k-dialog-title">钉住多张</AlertDialog.Title>
          <AlertDialog.Description className="k-dialog-desc">选了 {pinMany.cards.length} 张，一次最多钉住 {PIN_LIMIT} 张。钉住前 {PIN_LIMIT} 张？</AlertDialog.Description>
          <div className="k-dialog-foot">
            <span className="k-grow" />
            <AlertDialog.Close className="k-btn">取消</AlertDialog.Close>
            <button type="button" className="k-btn is-primary" onClick={() => {
              const { cards, point } = pinMany;
              setPinMany(null);
              void pinNow(cards.slice(0, PIN_LIMIT), point);
            }}>钉住前 {PIN_LIMIT} 张</button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>}
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
