import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { FolderInput, FolderMinus, RotateCcw, Trash2, X } from "lucide-react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ImageEdit } from "../bindings/ImageEdit";
import { editImages, workspaceSidebar } from "../ipc";
import { arcSpring, Dock, type DockItem } from "../ui/Dock";
import { MenuItem } from "../ui/Menu";
import { useReducedMotion } from "../ui/reducedMotion";
import { flattenFolders, PermanentDeleteConfirm } from "./SelectionPanel";
import { useToast } from "../ui/Toast";

/**
 * 多选的悬浮操作栏（#98，#180）：查看器同款 Dock，浮在图片墙底部。读数是“已选 N 张”，每项一格图标：
 * 移到文件夹 | 移出此文件夹（文件夹浏览范围） | 移到回收站（轻提示里可撤销）；回收站里只有 恢复 | 永久删除…；最后是取消选择。
 * 只在选了两张及以上时出现（单张的这些操作在右键菜单里）。left 是 selectionBarPlacement 算出的水平位置；
 * onWidth 报告自己的宽度。升起、离开与左右挪动都用 Dock 的形变弹簧，减少动画时直接到位。
 * 选择定不下一个图库时（跨图库，或含多份来源的图）libraryId 是 null，操作交给 acrossLibraries。
 */
export function SelectionBar({
  libraryId,
  acrossLibraries,
  scope,
  ids,
  onClear,
  reloadKey,
  onError,
  safeMode = false,
  left,
  onWidth,
  compact = false,
}: {
  libraryId: string | null;
  /** 与右键菜单同一条写入：按卡片显示的那份来源、按图库分组。folderLibrary 是这些来源共同的图库，没有就不能放进文件夹。 */
  acrossLibraries?: { folderLibrary: string | null; edit: (edits: ImageEdit[], clear: boolean) => void };
  scope: BrowseScope;
  ids: string[];
  onClear: () => void;
  reloadKey: number;
  onError: (error: unknown) => void;
  safeMode?: boolean;
  left: number;
  /** 量到的宽度，以及量的是不是紧凑的悬浮栏。 */
  onWidth: (width: number, compact: boolean) => void;
  /** 图片墙很窄时（selectionBarCompact）：读数只写“N 张”。 */
  compact?: boolean;
}) {
  const { t } = useTranslation("inspector");
  const reduced = useReducedMotion();
  const toast = useToast();
  const [folders, setFolders] = useState<{ id: string; label: string }[] | null>(null);
  const [purging, setPurging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selectionKey = ids.join("\n");
  const currentKey = useRef(selectionKey);
  currentKey.current = selectionKey;
  // 换了选中的图片就收起永久删除的确认；在渲染中比较，换选择的这一帧就不显示旧的确认。
  const [purgingFor, setPurgingFor] = useState(selectionKey);
  if (purgingFor !== selectionKey) {
    setPurgingFor(selectionKey);
    setPurging(false);
  }

  const folderLibrary = libraryId ?? acrossLibraries?.folderLibrary ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadKey): reloadKey 变了要重新读文件夹列表
  useEffect(() => {
    if (folderLibrary === null) {
      setFolders(null);
      return;
    }
    let alive = true;
    workspaceSidebar(folderLibrary, safeMode).then(
      (s) => alive && setFolders(flattenFolders(s.folders)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [folderLibrary, reloadKey, safeMode]);

  // 观察者只接一次，报告时读这次渲染的 onWidth 与 compact。
  const reportWidth = useEffectEvent((width: number) => onWidth(width, compact));
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => reportWidth(el.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // 只在挂上时接上观察；宽度变化由观察者报告。
  }, []);

  const edit = (edits: ImageEdit[], clear: boolean) => {
    if (libraryId === null) {
      acrossLibraries?.edit(edits, clear);
      return;
    }
    const key = selectionKey,
      picked = ids;
    void editImages(libraryId, picked, edits).then(
      () => {
        if (clear && currentKey.current === key) onClear();
        // 移到回收站能撤销：不先确认，给一个带“撤销”的轻提示。
        if (edits.length === 1 && edits[0].kind === "delete")
          toast.show({
            title: t("selection.trashed"),
            description: t("selection.trashedCount", { count: picked.length }),
            tone: "success",
            action: {
              label: t("selection.undo"),
              onClick: () => void editImages(libraryId, picked, [{ kind: "restore" }]).catch((e) => onError(e)),
            },
          });
      },
      (e) => {
        if (currentKey.current === key) onError(e);
      },
    );
  };

  const hasFolders = !!folders?.length;
  const trash = scope.kind === "trash";
  const items: DockItem[] = [
    ...(trash
      ? []
      : [
          {
            id: "put",
            label: t("selection.moveToFolder"),
            icon: <FolderInput size={18} strokeWidth={1.75} />,
            disabled: !hasFolders,
            note: folders && !hasFolders ? t("selection.noFolders") : undefined,
            menuWidth: 220,
            menu: (folders ?? []).map((f) => (
              <MenuItem key={f.id} onClick={() => edit([{ kind: "addToFolder", folderId: f.id }], false)}>
                {f.label}
              </MenuItem>
            )),
          },
          ...(scope.kind === "folder"
            ? [
                {
                  id: "remove",
                  label: t("selection.removeFromFolder"),
                  icon: <FolderMinus size={18} strokeWidth={1.75} />,
                },
              ]
            : []),
          "sep" as const,
        ]),
    ...(trash
      ? [
          { id: "restore", label: t("selection.restore"), icon: <RotateCcw size={18} strokeWidth={1.75} /> },
          {
            id: "purge",
            label: t("selection.purge"),
            tone: "danger" as const,
            icon: <Trash2 size={18} strokeWidth={1.75} />,
          },
        ]
      : [
          {
            id: "delete",
            label: t("selection.trash"),
            shortcut: "Del",
            tone: "danger" as const,
            icon: <Trash2 size={18} strokeWidth={1.75} />,
          },
        ]),
    { id: "clear", label: t("selection.clear"), icon: <X size={18} strokeWidth={1.75} /> },
  ];
  const run = (id: string) => {
    if (id === "remove" && scope.kind === "folder") edit([{ kind: "removeFromFolder", folderId: scope.id }], true);
    else if (id === "restore") edit([{ kind: "restore" }], true);
    else if (id === "delete") edit([{ kind: "delete" }], true);
    else if (id === "purge") setPurging(true);
    else if (id === "clear") onClear();
  };

  const instant = { duration: 0 };
  return (
    <motion.div
      ref={root}
      className="selbar-float"
      initial={{ opacity: 0, y: reduced ? 0 : 24, x: left }}
      animate={{ opacity: 1, y: 0, x: left }}
      exit={{ opacity: 0, y: reduced ? 0 : 24 }}
      transition={reduced ? instant : arcSpring.morph}
    >
      <Dock
        label={t("selection.actions")}
        items={items}
        onSelect={run}
        className={compact ? "is-compact" : ""}
        readout={
          compact ? (
            <b aria-label={t("selection.count", { count: ids.length })}>
              {t("selection.countShort", { count: ids.length })}
            </b>
          ) : (
            <b>{t("selection.count", { count: ids.length })}</b>
          )
        }
      />
      {purging && libraryId !== null && scope.kind === "trash" && (
        <PermanentDeleteConfirm
          libraryId={libraryId}
          ids={ids}
          safeMode={safeMode}
          onDone={() => {
            setPurging(false);
            onClear();
          }}
          onCancel={() => setPurging(false)}
          onError={toast.error}
        />
      )}
    </motion.div>
  );
}
