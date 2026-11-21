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
  removeGroupMember,
  renameReferenceGroup,
  repinAllGroupMembers,
  restoreReferenceGroup,
  setReferenceGroupFavorite,
  showGroupMember,
  switchReferenceGroup,
  undoPruneUnpinned,
} from "../ipc";
import { describeCommandError, errorText, isErrorCode } from "../ipc/commandError";
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
import { ReferenceGroupsPanel } from "./ReferenceGroupsPanel";

type Desk = { state: "loading" } | { state: "off" } | { state: "on"; lists: DeskLists };

/**
 * 参考组改成桌面（#588）的开关（设置里界面上没有的 `deskReferenceGroups`）开着没有，开着时还有
 * 常用、最近、更早三段。参考组变了（切换、设为常用、钉上第一张……）时重读。
 */
function useDesk(): { desk: Desk; failed: unknown } {
  const [desk, setDesk] = useState<Desk>({ state: "loading" });
  const [failed, setFailed] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      deskReferenceGroups().then(
        (lists) => {
          if (!alive) return;
          setDesk({ state: "on", lists });
          setFailed(null);
        },
        (e) => {
          if (!alive) return;
          if (isErrorCode(e, "deskGroupsOff")) setDesk({ state: "off" });
          else setFailed(e);
        },
      );
    void load();
    const unlisten = onReferenceGroupsChanged(() => void load());
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);
  return { desk, failed };
}

/**
 * 侧栏“参考组”（图标轨 Ctrl+2）：开关关着时是原来的面板（{@link ReferenceGroupsPanel}），
 * 开着时是常用、最近、更早三段（{@link DeskGroupsPanel}，#592）。
 */
export function ReferenceGroups() {
  const { desk, failed } = useDesk();
  const toast = useToast();
  useEffect(() => {
    if (failed) toast.error(errorText(failed));
  }, [failed, toast]);
  if (desk.state === "off") return <ReferenceGroupsPanel />;
  if (desk.state === "loading") return <section className="reference-groups" aria-busy="true" />;
  return <DeskGroupsPanel lists={desk.lists} />;
}

/** 侧栏标题行右侧的“新参考组”（#592）：清空桌面。桌面已经空着时变灰；开关关着时不出现。 */
export function DeskNewGroupButton() {
  const { desk } = useDesk();
  const toast = useToast();
  const { t } = useTranslation("desktop", { keyPrefix: "deskPanel" });
  if (desk.state !== "on") return null;
  const empty = desk.lists.onDesk === null;
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
    registeredLibraries().then(
      (list) => setLibraryNames(new Map(list.map((r) => [r.library.id, r.library.name]))),
      (e) => toast.error(errorText(e)),
    );
  }, [toast]);

  // 桌面上那组的成员：桌面一变就重读（钉回、关掉钉图时更新时间不一定变）。
  useEffect(() => {
    let alive = true;
    for (const g of [...lists.favorites, ...lists.recent, ...lists.older]) {
      if (g.problem || g.id !== lists.onDesk) continue;
      referenceGroup(g.id).then(
        (view) => {
          if (alive && view) setViews((prev) => new Map(prev).set(g.id, { at: g.updatedAt, view }));
        },
        () => {},
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
   * 撤销记录只有最近一次那份（移出与“移出没钉着的”共用）：新的“撤销”提示出来时关掉同一份记录的旧提示，
   * 旧提示上的“撤销”不会撤到新的那次上。撤销写不进时记录还在，错误提示上带“撤销”再试一次。
   */
  const undoToasts = useRef(new Map<() => Promise<void>, string>());
  const offerUndo = (shown: { title: string } | { error: unknown }, undo: () => Promise<void>) => {
    const previous = undoToasts.current.get(undo);
    if (previous) toast.close(previous);
    const action = {
      label: t("groups.undo"),
      onClick: () => void undo().catch((error) => offerUndo({ error }, undo)),
    };
    const id =
      "title" in shown
        ? toast.show({ title: shown.title, tone: "success", action })
        : toast.error(errorText(shown.error), { action });
    undoToasts.current.set(undo, id);
  };

  /** 移出能撤销，所以不先确认：做完给带“撤销”的轻提示（只撤销最近一次）。`title` 为 `null` 时什么都没做。 */
  const undoable = async <T,>(action: () => Promise<T>, title: (value: T) => string | null) => {
    try {
      const text = title(await action());
      if (text) offerUndo({ title: text }, undoPruneUnpinned);
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
            primary={false}
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
                () => removeGroupMember(g.id, memberId),
                () => t("deskPanel.removed"),
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
        <FluidList className="desk-groups-tray" layoutKey={layoutKey}>
          <ul className="desk-groups-list" id={`${id}-list`} aria-label={title}>
            {children}
          </ul>
        </FluidList>
      )}
    </div>
  );
}
