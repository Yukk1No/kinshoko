import { useEffect, useState } from "react";
import { CheckSquare, ClipboardPaste, Copy, Crop, Download, FileImage, FolderMinus, FolderOpen, FolderSearch, Images, Layers, Maximize2, Pin, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { FolderGlyph, Menu, MenuItem, MenuRadioItem, MenuSeparator, MenuSubmenu, MenuTip } from "../ui/Menu";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ContentRating } from "../bindings/ContentRating";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { ImageEdit } from "../bindings/ImageEdit";
import type { BrowserCard } from "./Wall";

/** 右键菜单作用的对象：一组卡片（右键的那张，或它所在的整组选择），或图片墙的空白处。point 为指针位置（CSS 像素，窗口客户区）。 */
export type WallMenuTarget =
  | { kind: "cards"; cards: BrowserCard[]; point: { x: number; y: number } }
  | { kind: "blank"; point: { x: number; y: number } };

export type ImportSource = "files" | "folder" | "eagle";

/** 菜单项调用的动作。每一项另有入口：快捷键、选择操作条、详情面板、导入按钮或拖放。 */
export type WallMenuActions = {
  open: (card: BrowserCard) => void;
  pin: (cards: BrowserCard[], point: { x: number; y: number }) => void;
  /** 打开查看器并进入框选。 */
  crop: (card: BrowserCard) => void;
  /** clear：整理后这些图会离开当前范围（移出、删除、还原），随之取消选择。 */
  edit: (cards: BrowserCard[], edits: ImageEdit[], clear: boolean) => void;
  addToGroup: (cards: BrowserCard[], groupId: string) => void;
  inspectSources: (card: BrowserCard) => void;
  /** 彻底删除（先确认受影响的参考组）。 */
  purge: (cards: BrowserCard[]) => void;
  importFrom: (source: ImportSource) => void;
  /** 复制图片：原图像素放进剪贴板（#105）。 */
  copy: (card: BrowserCard) => void;
  /** 在资源管理器中显示原文件（#105）。 */
  reveal: (card: BrowserCard) => void;
  /** 从剪贴板导入，走普通导入与保存位置选择（#105）。 */
  importClipboard: () => void;
  /** 剪贴板里有没有图片；菜单打开时读一次，没有时“从剪贴板导入”禁用。 */
  clipboardHasImage: () => Promise<boolean>;
  selectAll: () => void;
  setDensity: (value: number) => void;
  folders: (libraryId: string) => Promise<{ id: string; label: string }[]>;
  /** 这张图是否直接放在这个文件夹里（不算子文件夹）；“含子文件夹”的范围里据此决定能否“从此文件夹移出”。 */
  inFolder: (card: BrowserCard, folderId: string) => Promise<boolean>;
  groups: () => Promise<GroupSummary[]>;
};

/** 图片大小的几档预设（目标列宽，与密度滑条同一个值）。 */
export const DENSITY_PRESETS: { value: number; label: string }[] = [
  { value: 160, label: "小" }, { value: 240, label: "中" }, { value: 320, label: "大" }, { value: 400, label: "特大" },
];

const RATINGS: { value: ContentRating; label: string }[] = [
  { value: "general", label: "全年龄" }, { value: "sensitive", label: "轻度" }, { value: "questionable", label: "敏感" }, { value: "explicit", label: "成人" },
];

const icon = (Icon: typeof Pin) => <Icon size={14} />;

/** 菜单打开时读一次剪贴板：读到之前与读不到时不禁用（真去导入时再报告原因）。 */
function ClipboardImport({ actions }: { actions: WallMenuActions }) {
  const [hasImage, setHasImage] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    actions.clipboardHasImage().then((value) => alive && setHasImage(value), () => {});
    return () => { alive = false; };
    // 每次打开菜单只读一次。
  }, []);
  return <MenuItem icon={icon(ClipboardPaste)} kbd="Ctrl V" disabled={hasImage === false} onClick={actions.importClipboard}>从剪贴板导入</MenuItem>;
}

/** 子菜单打开时才读的列表；读不到时显示原因。 */
function useList<T>(load: () => Promise<T[]>) {
  const [state, setState] = useState<{ items: T[] | null; problem: string | null }>({ items: null, problem: null });
  useEffect(() => {
    let alive = true;
    load().then((items) => alive && setState({ items, problem: null }), (e) => alive && setState({ items: [], problem: String(e) }));
    return () => { alive = false; };
    // 每次打开子菜单只读一次。
  }, []);
  return state;
}

function FolderList({ libraryId, actions, cards }: { libraryId: string; actions: WallMenuActions; cards: BrowserCard[] }) {
  const { items, problem } = useList(() => actions.folders(libraryId));
  if (!items) return <MenuTip>正在读取文件夹…</MenuTip>;
  if (problem) return <MenuTip>{problem}</MenuTip>;
  if (!items.length) return <MenuTip>这个图库还没有文件夹</MenuTip>;
  return <>{items.map((f) => <MenuItem key={f.id} onClick={() => actions.edit(cards, [{ kind: "addToFolder", folderId: f.id }], false)}>{f.label}</MenuItem>)}</>;
}

function GroupList({ actions, cards }: { actions: WallMenuActions; cards: BrowserCard[] }) {
  const { items, problem } = useList(actions.groups);
  if (!items) return <MenuTip>正在读取参考组…</MenuTip>;
  if (problem) return <MenuTip>{problem}</MenuTip>;
  const usable = items.filter((g) => !g.problem);
  if (!usable.length) return <MenuTip>还没有参考组，可在侧栏“参考组”里新建</MenuTip>;
  return <>{usable.map((g) => <MenuItem key={g.id} onClick={() => actions.addToGroup(cards, g.id)}>{g.name}</MenuItem>)}</>;
}

/**
 * “从此文件夹移出”：只看这个文件夹（scope folder）时范围里的图都直接在里面；含子文件夹（folderTree，
 * 默认）时范围里也有子文件夹里的图，菜单打开时问一次这张图是否直接在这个文件夹里，是才显示。
 */
function RemoveFromFolder({ card, folderId, direct, actions }: { card: BrowserCard; folderId: string; direct: boolean; actions: WallMenuActions }) {
  const [member, setMember] = useState(direct);
  useEffect(() => {
    if (direct) return;
    let alive = true;
    actions.inFolder(card, folderId).then((value) => alive && setMember(value), () => {});
    return () => { alive = false; };
    // 每次打开菜单只问一次。
  }, []);
  if (!member) return null;
  return <MenuItem icon={icon(FolderMinus)} onClick={() => actions.edit([card], [{ kind: "removeFromFolder", folderId }], true)}>从此文件夹移出</MenuItem>;
}

function Organize({ cards, actions, scope, single }: { cards: BrowserCard[]; actions: WallMenuActions; scope: BrowseScope; single: boolean }) {
  const libraries = new Set(cards.map((c) => c.libraryId ?? ""));
  const libraryId = libraries.size === 1 ? [...libraries][0] : null;
  return <>
    <MenuSubmenu icon={<FolderGlyph />} label="移到文件夹" disabled={libraryId === null} popupLabel="移到文件夹" width={220}
      meta={libraryId === null ? "来自多个图库" : undefined}>
      {libraryId !== null && <FolderList libraryId={libraryId} actions={actions} cards={cards} />}
    </MenuSubmenu>
    {single && (scope.kind === "folder" || scope.kind === "folderTree") &&
      <RemoveFromFolder card={cards[0]} folderId={scope.id} direct={scope.kind === "folder"} actions={actions} />}
    <MenuSubmenu icon={icon(Layers)} label="加入参考组" popupLabel="加入参考组" width={220}>
      <GroupList actions={actions} cards={cards} />
    </MenuSubmenu>
    <MenuSubmenu icon={icon(ShieldCheck)} label="内容分级" popupLabel="内容分级">
      {RATINGS.map((r) => <MenuItem key={r.value} onClick={() => actions.edit(cards, [{ kind: "setRating", rating: r.value }], false)}>{r.label}</MenuItem>)}
      <MenuSeparator />
      <MenuItem icon={icon(RotateCcw)} onClick={() => actions.edit(cards, [{ kind: "revertRating" }], false)}>改回自动</MenuItem>
    </MenuSubmenu>
  </>;
}

/**
 * 图片墙的右键菜单内容（#102 “右键菜单”表的瀑布流各行）：单张、多张、回收站范围与空白处。
 * 复制图片、在资源管理器中显示与从剪贴板导入是 #105 的新能力。
 */
export function WallMenu({ target, scope, density, actions }: {
  target: WallMenuTarget; scope: BrowseScope; density: number; actions: WallMenuActions;
}) {
  if (target.kind === "blank") {
    return <>
      <MenuSubmenu icon={icon(Download)} label="导入" popupLabel="导入">
        <MenuItem icon={icon(FileImage)} kbd="Ctrl O" onClick={() => actions.importFrom("files")}>图片</MenuItem>
        <MenuItem icon={icon(FolderOpen)} onClick={() => actions.importFrom("folder")}>文件夹</MenuItem>
        <MenuItem icon={icon(Images)} onClick={() => actions.importFrom("eagle")}>从 Eagle…</MenuItem>
      </MenuSubmenu>
      <ClipboardImport actions={actions} />
      <MenuItem icon={icon(CheckSquare)} kbd="Ctrl A" onClick={actions.selectAll}>全选</MenuItem>
      <MenuSubmenu icon={icon(Maximize2)} label="图片大小" popupLabel="图片大小">
        <Menu.RadioGroup value={DENSITY_PRESETS.some((p) => p.value === density) ? density : null}
          onValueChange={(value) => actions.setDensity(value as number)}>
          {DENSITY_PRESETS.map((p) => <MenuRadioItem key={p.value} value={p.value}>{p.label}</MenuRadioItem>)}
        </Menu.RadioGroup>
      </MenuSubmenu>
    </>;
  }
  const { cards, point } = target;
  if (scope.kind === "trash") {
    return <>
      <MenuItem icon={icon(RotateCcw)} onClick={() => actions.edit(cards, [{ kind: "restore" }], true)}>还原</MenuItem>
      <MenuSeparator />
      <MenuItem icon={icon(Trash2)} danger onClick={() => actions.purge(cards)}>彻底删除…</MenuItem>
    </>;
  }
  if (cards.length === 1) {
    const [card] = cards;
    const sources = card.sources ?? [];
    return <>
      <MenuItem icon={icon(Maximize2)} kbd="Enter" onClick={() => actions.open(card)}>打开</MenuItem>
      <MenuItem icon={icon(Pin)} kbd="P" onClick={() => actions.pin(cards, point)}>钉住整图</MenuItem>
      <MenuItem icon={icon(Crop)} kbd="F1" onClick={() => actions.crop(card)}>框选局部钉住</MenuItem>
      <MenuItem icon={icon(Copy)} kbd="Ctrl C" onClick={() => actions.copy(card)}>复制图片</MenuItem>
      <MenuSeparator />
      <Organize cards={cards} actions={actions} scope={scope} single />
      {sources.length >= 2 && <MenuItem icon={icon(Layers)} onClick={() => actions.inspectSources(card)}>查看来源</MenuItem>}
      <MenuSeparator />
      <MenuItem icon={icon(FolderSearch)} onClick={() => actions.reveal(card)}>在资源管理器中显示</MenuItem>
      <MenuSeparator />
      <MenuItem icon={icon(Trash2)} kbd="Del" danger onClick={() => actions.edit(cards, [{ kind: "delete" }], true)}>移到回收站</MenuItem>
    </>;
  }
  return <>
    <MenuItem icon={icon(Pin)} kbd="P" onClick={() => actions.pin(cards, point)}>钉住 {cards.length} 张</MenuItem>
    <MenuItem icon={icon(Copy)} disabled className="has-meta">复制<span className="k-item-meta">一次只能复制一张</span></MenuItem>
    <MenuSeparator />
    <Organize cards={cards} actions={actions} scope={scope} single={false} />
    <MenuSeparator />
    <MenuItem icon={icon(Trash2)} kbd="Del" danger onClick={() => actions.edit(cards, [{ kind: "delete" }], true)}>移到回收站（{cards.length} 张）</MenuItem>
  </>;
}
