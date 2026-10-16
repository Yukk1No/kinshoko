import { useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ScreenRect } from "../bindings/ScreenRect";
import type { WorkspaceSourceTarget } from "../bindings/WorkspaceSourceTarget";
import { pinReference, referenceGroups, workspaceEditSource, workspaceSidebar, workspaceSourceGroup } from "../ipc";
import { flattenFolders, PermanentDeleteConfirm } from "../library/SelectionPanel";
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
  /** 后端当前的写入资料库：一次彻底删除多张图只在它上面进行。 */
  activeLibraryId: string;
  onOpen: (card: BrowserCard) => void;
  onCrop: (card: BrowserCard) => void;
  onInspect: (card: BrowserCard) => void;
  /** 整理写入后：重新浏览并刷新词表。 */
  onChanged: () => void;
  onClearSelection: () => void;
  onError: (message: string) => void;
  importFrom: (source: ImportSource) => void;
  selectAll: () => void;
  setDensity: (value: number) => void;
};

/**
 * 图片墙右键菜单与快捷键背后的动作：钉住（最多 20 张，超过先确认）、按来源整理、加入参考组、
 * 彻底删除（先确认受影响的参考组）。dialogs 由调用方放进界面。
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

  const actions: WallMenuActions = {
    open: (card) => options.current.onOpen(card),
    crop: (card) => options.current.onCrop(card),
    inspectSources: (card) => options.current.onInspect(card),
    importFrom: (source) => options.current.importFrom(source),
    selectAll: () => options.current.selectAll(),
    setDensity: (value) => options.current.setDensity(value),
    pin(cards, point) {
      if (cards.length > PIN_LIMIT) setPinMany({ cards, point });
      else void pinNow(cards, point);
    },
    edit(cards, edits, clear) {
      const { safe, activeLibraryId, onChanged, onClearSelection, onError } = options.current;
      void (async () => {
        try {
          for (const card of cards) await workspaceEditSource(targetOf(card, activeLibraryId), safe, edits);
          if (clear) onClearSelection();
        } catch (e) {
          onError(String(e));
        } finally {
          onChanged();
        }
      })();
    },
    addToGroup(cards, groupId) {
      const { safe, activeLibraryId, onError } = options.current;
      void (async () => {
        try { for (const card of cards) await workspaceSourceGroup(targetOf(card, activeLibraryId), safe, { groupId }); } catch (e) { onError(String(e)); }
      })();
    },
    purge(cards) {
      const { activeLibraryId, onError } = options.current;
      const libraries = new Set(cards.map((card) => targetOf(card, activeLibraryId).libraryId));
      // 任一图库都可以整理（ADR-0008）：后端按需把可写句柄切到这些图所在的图库。
      if (libraries.size > 1) {
        onError("一次彻底删除多张只能在同一个图库的回收站里进行；可以逐张彻底删除。");
        return;
      }
      setPurging(cards);
    },
    folders: (libraryId) => workspaceSidebar(libraryId, options.current.safe).then((sidebar) => flattenFolders(sidebar.folders)),
    groups: () => referenceGroups(),
  };

  const purgeTarget = purging?.length === 1 ? targetOf(purging[0], o.activeLibraryId) : undefined;
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
    {purging && <PermanentDeleteConfirm
      libraryId={targetOf(purging[0], o.activeLibraryId).libraryId}
      ids={purging.map((card) => targetOf(card, o.activeLibraryId).imageId)}
      sourceTarget={purgeTarget}
      safeMode={o.safe}
      onDone={() => { setPurging(null); options.current.onClearSelection(); options.current.onChanged(); }}
      onCancel={() => setPurging(null)}
      onError={(message) => options.current.onError(message)}
    />}
  </>;
  return { actions, dialogs };
}
