import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderInput, Layers, MoreHorizontal, Plus } from "lucide-react";
import type { DeskLists } from "../bindings/DeskLists";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import {
  deleteReferenceGroup,
  deskReferenceGroups,
  duplicateReferenceGroup,
  exportReferenceGroupPackage,
  importReferenceGroupPackage,
  newReferenceDesk,
  onReferenceGroupsChanged,
  pruneUnpinnedMembers,
  purgeDeletedReferenceGroup,
  referenceGroup,
  registeredLibraries,
  removeDeskGroupMember,
  renameReferenceGroup,
  repinAllGroupMembers,
  restoreReferenceGroup,
  setReferenceGroupFavorite,
  splitOffReferenceGroup,
  showGroupMember,
  switchReferenceGroup,
  undoPruneUnpinned,
  undoSplitOff,
} from "../ipc";
import { describeCommandError, errorText } from "../ipc/commandError";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import { SaveDestinationDialog } from "../library/SaveDestination";
import { useIndicatorSlide } from "../library/useIndicatorSlide";
import { ContextMenu } from "@base-ui/react/context-menu";
import { FluidList, FluidRow } from "../ui/FluidList";
import { Menu, MenuPopup } from "../ui/Menu";
import { Name } from "../ui/Name";
import { Tip } from "../ui/Tip";
import { useToast } from "../ui/Toast";
import { WarnIcon } from "../ui/WarnIcon";
import { DeskGroupMembers } from "./DeskGroupMembers";
import { DeskGroupMenuItems } from "./DeskGroupMenu";
import { GroupNameForm } from "./GroupNameForm";
import { groupLabel } from "./groupLabel";

const DESK_KEY = "desk-reference-groups";

/**
 * 桌面参考组名单的后端镜像（#761）。多个挂载点（列表与新建按钮）共享同一份读取与事件订阅；
 * 参考组变化事件不携带名单，失效后由镜像重读，代次防乱序交给 #741 的原语。
 */
const deskMirror = createBackendMirror<typeof DESK_KEY, DeskLists>({
  read: () => deskReferenceGroups(),
  listen: (invalidate) => onReferenceGroupsChanged(() => invalidate(DESK_KEY)),
});

function useDesk() {
  return useBackendMirror(deskMirror, DESK_KEY);
}

/** 侧栏“参考组”（图标轨 Ctrl+2）：常用、最近、更早三段（{@link DeskGroupsPanel}，#592）。 */
export function ReferenceGroups() {
  const { value: lists, error } = useDesk();
  const toast = useToast();
  useEffect(() => {
    if (error) toast.error(errorText(error));
  }, [error, toast]);
  if (lists === null) return <section className="reference-groups" aria-busy="true" />;
  return <DeskGroupsPanel lists={lists} />;
}

/** 侧栏标题行右侧的“新参考组”（#592）：清空桌面。桌面已经空着时变灰。 */
export function DeskNewGroupButton() {
  const { value: lists } = useDesk();
  const toast = useToast();
  const { t } = useTranslation("desktop", { keyPrefix: "deskPanel" });
  if (lists === null) return null;
  const empty = lists.onDesk === null;
  return (
    <Tip label={t("newGroup")}>
      <button
        type="button"
        className="k-icon-btn desk-new-group"
        aria-label={t("newGroup")}
        disabled={empty}
        onClick={() => void newReferenceDesk().catch((e) => toast.error(errorText(e)))}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </Tip>
  );
}

/**
 * 常用、最近、更早三段（#592）。单击一项就整桌换成它；桌面上的那一项由左边的短条标出并展开成员，
 * 换一项时只有短条滑过去（useIndicatorSlide），行本身不做位置动画：列表重读、成员展开时不整列重排。
 * “更早”默认折起。减弱动效时都直接到终态。
 */
export function DeskGroupsPanel({ lists }: { lists: DeskLists }) {
  const { t } = useTranslation("desktop");
  const toast = useToast();
  const [libraryNames, setLibraryNames] = useState<Map<string, string>>(new Map());
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<SectionKey>>(() => new Set(["older"]));
  const paneRef = useRef<HTMLElement>(null);
  useIndicatorSlide(paneRef);
  const [importing, setImporting] = useState(false);
  /** 桌面上那组的成员，按参考组 id 记下。 */
  const [views, setViews] = useState<Map<string, { at: number; view: ReferenceGroupView }>>(new Map());

  const all = [...lists.favorites, ...lists.recent, ...lists.older];

  useEffect(() => {
    let alive = true;
    registeredLibraries().then(
      (list) => {
        if (alive) setLibraryNames(new Map(list.map((r) => [r.library.id, r.library.name])));
      },
      (e) => {
        if (alive) toast.error(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [toast]);

  // 桌面上那组的成员：桌面一变就重读（钉回、关掉钉图时更新时间不一定变）；同时清理已不存在的旧组缓存。
  useEffect(() => {
    let alive = true;
    const liveIds = new Set([...lists.favorites, ...lists.recent, ...lists.older].map((g) => g.id));
    setViews((prev) => {
      let stale = false;
      for (const id of prev.keys()) {
        if (!liveIds.has(id)) {
          stale = true;
          break;
        }
      }
      if (!stale) return prev;
      const next = new Map<string, { at: number; view: ReferenceGroupView }>();
      for (const [id, entry] of prev) {
        if (liveIds.has(id)) next.set(id, entry);
      }
      return next;
    });
    for (const g of [...lists.favorites, ...lists.recent, ...lists.older]) {
      if (g.problem || g.id !== lists.onDesk) continue;
      referenceGroup(g.id).then(
        (view) => {
          if (alive && view) setViews((prev) => new Map(prev).set(g.id, { at: g.updatedAt, view }));
        },
        () => {
          // 忽略失败：读不到成员时保持折叠行本身可切换。
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [lists]);

  const run = async (action: () => Promise<unknown>, done?: (value: unknown) => string | null) => {
    try {
      const value = await action();
      const text = done?.(value);
      if (text) toast.show({ title: text, tone: "success" });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  /**
   * 撤销记录各只有最近一次那份（移出与“移出没钉着的”共用一份，移到新参考组一份）：新的“撤销”提示出来时
   * 关掉同一份记录的旧提示，旧提示上的“撤销”不会撤到新的那次上。撤销写不进时记录还在，
   * 错误提示上带“撤销”再试一次。
   */
  const undoToasts = useRef(new Map<() => Promise<void>, string>());
  const offerUndo = (
    shown: { title: string } | { error: unknown; description?: string },
    undo: () => Promise<void>,
  ) => {
    const previous = undoToasts.current.get(undo);
    if (previous) toast.close(previous);
    const action = {
      label: t("groups.undo"),
      onClick: () => void undo().catch((error) => offerUndo({ error }, undo)),
    };
    const id =
      "title" in shown
        ? toast.show({ title: shown.title, tone: "success", action })
        : toast.error(errorText(shown.error), { action, description: shown.description });
    undoToasts.current.set(undo, id);
  };

  /**
   * 移出、移到新参考组能撤销，所以不先确认：做完给带“撤销”的轻提示（只撤销最近一次）。`title` 为 `null` 时什么都没做；
   * 给出 `error` 时做成了一半（如成员已移走、没能摆上桌面），错误提示上照样带“撤销”。
   */
  const undoable = async <T,>(
    action: () => Promise<T>,
    title: (value: T) => string | { error: unknown; description: string } | null,
    undo: () => Promise<void> = undoPruneUnpinned,
  ) => {
    try {
      const shown = title(await action());
      if (shown) offerUndo(typeof shown === "string" ? { title: shown } : shown, undo);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const prune = () => undoable(pruneUnpinnedMembers, (count) => (count > 0 ? t("deskPanel.pruned", { count }) : null));

  /** 删除能撤销，所以不先确认：直接删，再给带“撤销”的轻提示。提示关了还没撤销就真正删除暂放的那份。 */
  const removeGroup = async (g: GroupSummary) => {
    let undone = false;
    try {
      const deleted = await deleteReferenceGroup(g.id);
      toast.show({
        title: t("groups.deleted"),
        description: groupLabel(g),
        tone: "success",
        action: {
          label: t("groups.undo"),
          onClick: () => {
            undone = true;
            restoreReferenceGroup(deleted).catch((e) => toast.error(errorText(e)));
          },
        },
        onClose: () => {
          // 忽略失败：删不掉的暂放内容由程序下次启动时清掉，界面上参考组已经删除。
          if (!undone) void purgeDeletedReferenceGroup(g.id).catch(() => {});
        },
      });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const toggleSection = (section: SectionKey) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(section)) next.add(section);
      return next;
    });

  let rowIndex = 0;
  const item = (g: GroupSummary, section: SectionKey) => {
    const label = groupLabel(g);
    const onDesk = g.id === lists.onDesk;
    const view = onDesk ? views.get(g.id)?.view : undefined;
    const unpinned = !!view?.group.members.some((m) => m.pinned === false);
    const menuItems = (
      <DeskGroupMenuItems
        usable={!g.problem}
        favorite={section === "favorites"}
        onDesk={onDesk}
        canPrune={unpinned}
        onRename={() => setRenaming({ id: g.id, name: g.name })}
        onFavorite={(favorite) => void run(() => setReferenceGroupFavorite(g.id, favorite))}
        onCopy={() =>
          void run(
            () => duplicateReferenceGroup(g.id, t("deskPanel.copyName", { name: label })),
            () => t("deskPanel.copied"),
          )
        }
        onPrune={() => void prune()}
        onExport={() =>
          void run(
            () => exportReferenceGroupPackage(g.id),
            (path) => (path ? t("groups.exported", { path: String(path) }) : null),
          )
        }
        onDelete={() => void removeGroup(g)}
      />
    );
    const rowBody = (
      <>
        <span className="k-row-icon" aria-hidden="true">
          {g.problem ? <WarnIcon /> : <Layers size={15} />}
        </span>
        <Name className="sidebar-label k-label">{label}</Name>
        <span className="sidebar-count k-label" aria-hidden="true">
          {g.problem ? "" : g.memberCount}
        </span>
      </>
    );
    return (
      <li key={g.id} className="desk-group" data-id={g.id}>
        {renaming?.id === g.id ? (
          <GroupNameForm
            title={t("groups.renameTitle")}
            label={t("groups.nameLabel")}
            value={renaming.name}
            allowEmpty
            onChange={(value) => setRenaming({ id: g.id, name: value })}
            onCancel={() => setRenaming(null)}
            onSubmit={() =>
              void run(
                () => renameReferenceGroup(g.id, renaming.name),
                () => (setRenaming(null), null),
              )
            }
          />
        ) : (
          <FluidRow index={rowIndex++} className="desk-group-row">
            <ContextMenu.Root>
              <ContextMenu.Trigger
                render={
                  g.problem ? (
                    <div className="k-row desk-group-head" aria-label={label} />
                  ) : (
                    <button
                      type="button"
                      className="sidebar-item k-row desk-group-head"
                      aria-label={label}
                      aria-current={onDesk ? "page" : undefined}
                      onClick={() => {
                        if (!onDesk) void run(() => switchReferenceGroup(g.id));
                      }}
                    />
                  )
                }
              >
                {rowBody}
              </ContextMenu.Trigger>
              <MenuPopup width={200} label={t("groups.moreLabel", { name: label })}>
                {menuItems}
              </MenuPopup>
            </ContextMenu.Root>
            <Menu.Root modal={false}>
              <Tip label={t("groups.more")}>
                <Menu.Trigger
                  className="k-icon-btn desk-group-more"
                  aria-label={t("groups.moreLabel", { name: label })}
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                </Menu.Trigger>
              </Tip>
              <MenuPopup width={200} label={t("groups.moreLabel", { name: label })}>
                {menuItems}
              </MenuPopup>
            </Menu.Root>
          </FluidRow>
        )}
        {g.problem && <p className="desk-group-problem">{describeCommandError(g.problem)}</p>}
        {view && renaming?.id !== g.id && (
          <DeskGroupMembers
            view={view}
            libraryNames={libraryNames}
            label={label}
            favorite={lists.favorites.some((f) => f.id === g.id)}
            // 钉回也带上参考组：复制出的参考组成员身份相同，只给成员身份会钉回桌面上另一组的那张。
            onRepin={(memberId) => void run(() => showGroupMember(g.id, memberId))}
            onShow={(memberId) => void run(() => showGroupMember(g.id, memberId))}
            onRepinAll={() => void run(() => repinAllGroupMembers())}
            onRemove={(memberId) =>
              void undoable(
                () => removeDeskGroupMember(g.id, memberId),
                // 那组已经不在桌面上时没有撤销记录，不给“撤销”。
                (undoable) => (undoable ? t("deskPanel.removed") : null),
              )
            }
            onSplit={(day) =>
              void undoable(
                () => splitOffReferenceGroup(day),
                (split) =>
                  !split
                    ? null
                    : split.switchError
                      ? { error: split.switchError, description: t("deskPanel.splitNotShown") }
                      : t("deskPanel.splitDone"),
                undoSplitOff,
              )
            }
          />
        )}
      </li>
    );
  };

  const deskLayout = `${lists.onDesk ?? ""}:${(lists.onDesk && views.get(lists.onDesk)?.view.group.members.length) || 0}`;

  const section = (key: SectionKey, groups: GroupSummary[]) =>
    groups.length > 0 && (
      <Section
        id={`desk-groups-${key}`}
        title={t(`deskPanel.${key}`)}
        count={groups.length}
        open={!folded.has(key)}
        onToggle={() => toggleSection(key)}
        layoutKey={deskLayout}
      >
        {groups.map((g) => item(g, key))}
      </Section>
    );

  return (
    <section ref={paneRef} className="reference-groups desk-groups side-bands" aria-label={t("groups.label")}>
      {importing && (
        <SaveDestinationDialog
          title={t("groups.importTitle")}
          confirmLabel={t("groups.importConfirm")}
          onClose={() => setImporting(false)}
          onConfirm={async (destination) => {
            const group = await importReferenceGroupPackage(destination.libraryId, destination);
            if (group) toast.show({ title: t("groups.imported", { name: group.name }), tone: "success" });
          }}
        />
      )}
      <div className="side-scroll">
        {all.length === 0 && <p className="k-description desk-groups-empty">{t("groups.empty")}</p>}
        {section("favorites", lists.favorites)}
        {section("recent", lists.recent)}
        {section("older", lists.older)}
      </div>
      <div className="side-foot">
        <FluidList>
          <FluidRow index={0}>
            <button type="button" className="sidebar-item k-row" onClick={() => setImporting(true)}>
              <span className="k-row-icon" aria-hidden="true">
                <FolderInput size={15} />
              </span>
              <span className="sidebar-label k-label">{t("groups.import")}</span>
            </button>
          </FluidRow>
        </FluidList>
      </div>
    </section>
  );
}

type SectionKey = "favorites" | "recent" | "older";

/**
 * 一段（#608 的图库行与托盘）：标题行留在纸上，30 高、13 px 加粗，前面是展开箭头，张数与行的张数成一列；
 * 段里的参考组放进一块浅凹槽，悬停的高亮块在槽里滑。
 */
function Section({
  id,
  title,
  count,
  open,
  onToggle,
  layoutKey,
  children,
}: {
  id: string;
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** 桌面上换了组、成员读到了：展开的成员挪了行（{@link FluidList} 的 `layoutKey`）。 */
  layoutKey: string;
  children: ReactNode;
}) {
  return (
    <div className="desk-groups-section">
      <h3 className="desk-groups-head">
        <button
          type="button"
          className="desk-groups-toggle"
          id={id}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onClick={onToggle}
        >
          <span className="desk-groups-chevron" aria-hidden="true">
            <ChevronRight size={14} />
          </span>
          <span className="sidebar-label">{title}</span>
          <span className="sidebar-count">{count}</span>
        </button>
      </h3>
      {open && (
        // 展开的成员夹在两行参考组之间：点它们旁边的空处不能转给下一行，换掉整张桌面。
        <FluidList className="desk-groups-tray" layoutKey={layoutKey} gapClick={false}>
          <ul className="desk-groups-list" id={`${id}-list`} aria-label={title}>
            {children}
          </ul>
        </FluidList>
      )}
    </div>
  );
}
