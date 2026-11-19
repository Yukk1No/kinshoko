import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGroup, motion } from "motion/react";
import {
  ChevronRight,
  Copy,
  Eraser,
  FolderInput,
  MoreHorizontal,
  PackageOpen,
  Pencil,
  Plus,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import type { DeskLists } from "../bindings/DeskLists";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { MemberStatus } from "../bindings/MemberStatus";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import {
  captureUrl,
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
  repinGroupMember,
  restoreReferenceGroup,
  setReferenceGroupFavorite,
  switchReferenceGroup,
  thumbnailUrl,
  undoPruneUnpinned,
} from "../ipc";
import { describeCommandError, errorText, isErrorCode } from "../ipc/commandError";
import { SaveDestinationDialog } from "../library/SaveDestination";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { useReducedMotion } from "../ui/reducedMotion";
import { Tip } from "../ui/Tip";
import { useToast } from "../ui/Toast";
import { WarnIcon } from "../ui/WarnIcon";
import { DeskGroupMembers } from "./DeskGroupMembers";
import { GroupNameForm } from "./GroupNameForm";
import { groupLabel } from "./groupLabel";
import { ReferenceGroupsPanel } from "./ReferenceGroupsPanel";

/** 与 tokens.css 的 `--t-slow` 相同：指示块滑动的时长，滑动中尺寸变了照样滑过去。 */
const SLIDE_MS = 260;

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
 * 常用、最近、更早三段（#592）。单击一项就整桌换成它；桌面上的那一项由一个指示块标出并展开成员，
 * 换一项时指示块滑过去，第一次出现直接到位。设为常用、取消常用、从更早回到最近时同一张卡片在段之间移动。
 * “更早”默认折起。减弱动效时都直接到终态。
 */
export function DeskGroupsPanel({ lists }: { lists: DeskLists }) {
  const { t } = useTranslation("desktop");
  const toast = useToast();
  const reduced = useReducedMotion();
  const [libraryNames, setLibraryNames] = useState<Map<string, string>>(new Map());
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [olderOpen, setOlderOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  /** 卡片缩略图与桌面上那组的成员，按参考组 id 与更新时间缓存。 */
  const [views, setViews] = useState<Map<string, { at: number; view: ReferenceGroupView }>>(new Map());

  const all = [...lists.favorites, ...lists.recent, ...lists.older];

  useEffect(() => {
    registeredLibraries().then(
      (list) => setLibraryNames(new Map(list.map((r) => [r.library.id, r.library.name]))),
      (e) => toast.error(errorText(e)),
    );
  }, [toast]);

  // 常用与最近的缩略图、桌面上那组的成员：每个版本读一次。读回来的版本与列表对不上（例如桌面上的改动
  // 还没落盘）时也记在列表的版本下，不一遍遍地读。
  // biome-ignore lint/correctness/useExhaustiveDependencies(views.get): 只读它跳过已缓存的；加进依赖会在每张缩略图回来时取消并重发其余请求
  useEffect(() => {
    let alive = true;
    for (const g of [...lists.favorites, ...lists.recent]) {
      // 桌面上那组钉回、关掉钉图时更新时间不一定变：每次都重读。
      if (g.problem || (g.id !== lists.onDesk && views.get(g.id)?.at === g.updatedAt)) continue;
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

  /** 移出能撤销，所以不先确认：做完给带“撤销”的轻提示（只撤销最近一次）。`title` 为 `null` 时什么都没做。 */
  const undoable = async <T,>(action: () => Promise<T>, title: (value: T) => string | null) => {
    try {
      const text = title(await action());
      if (!text) return;
      toast.show({
        title: text,
        tone: "success",
        action: {
          label: t("groups.undo"),
          onClick: () => void undoPruneUnpinned().catch((e) => toast.error(errorText(e))),
        },
      });
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

  const item = (g: GroupSummary, section: "favorites" | "recent" | "older") => {
    const label = groupLabel(g);
    const onDesk = g.id === lists.onDesk;
    const view = views.get(g.id)?.view;
    const unpinned = onDesk && !!view?.group.members.some((m) => m.pinned === false);
    const head = (
      <>
        {!onDesk && section !== "older" && view && view.members.length > 0 && (
          <Thumbs groupId={g.id} members={view.members} />
        )}
        <strong className="desk-group-name">{label}</strong>
        {g.problem ? (
          <span className="desk-group-problem">
            <WarnIcon />
            {describeCommandError(g.problem)}
          </span>
        ) : (
          (onDesk || section === "older") && (
            <span className="desk-group-meta">{t("groups.memberCount", { count: g.memberCount })}</span>
          )
        )}
      </>
    );
    return (
      <motion.li
        key={g.id}
        layout="position"
        layoutId={g.id}
        transition={reduced ? { duration: 0 } : undefined}
        className={`desk-group${onDesk ? " is-on" : ""}`}
        data-id={g.id}
      >
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
        ) : g.problem ? (
          <div className="desk-group-head">{head}</div>
        ) : (
          <button
            type="button"
            className="desk-group-head"
            aria-current={onDesk || undefined}
            onClick={() => {
              if (!onDesk) void run(() => switchReferenceGroup(g.id));
            }}
          >
            {head}
          </button>
        )}
        {renaming?.id !== g.id && (
          <Menu.Root>
            <Tip label={t("groups.more")}>
              <Menu.Trigger className="k-icon-btn desk-group-more" aria-label={t("groups.moreLabel", { name: label })}>
                <MoreHorizontal size={15} aria-hidden="true" />
              </Menu.Trigger>
            </Tip>
            <MenuPopup label={t("groups.moreLabel", { name: label })}>
              {!g.problem && (
                <>
                  <MenuItem icon={<Pencil size={14} />} onClick={() => setRenaming({ id: g.id, name: g.name })}>
                    {t("groups.rename")}
                  </MenuItem>
                  {section === "favorites" ? (
                    <MenuItem
                      icon={<StarOff size={14} />}
                      onClick={() => void run(() => setReferenceGroupFavorite(g.id, false))}
                    >
                      {t("deskPanel.unfavorite")}
                    </MenuItem>
                  ) : (
                    <MenuItem
                      icon={<Star size={14} />}
                      onClick={() => void run(() => setReferenceGroupFavorite(g.id, true))}
                    >
                      {t("deskPanel.favorite")}
                    </MenuItem>
                  )}
                  <MenuItem
                    icon={<Copy size={14} />}
                    onClick={() =>
                      void run(
                        () => duplicateReferenceGroup(g.id, t("deskPanel.copyName", { name: label })),
                        () => t("deskPanel.copied"),
                      )
                    }
                  >
                    {t("deskPanel.copy")}
                  </MenuItem>
                  {onDesk && (
                    <MenuItem icon={<Eraser size={14} />} disabled={!unpinned} onClick={() => void prune()}>
                      {t("deskPanel.prune")}
                    </MenuItem>
                  )}
                  <MenuItem
                    icon={<PackageOpen size={14} />}
                    onClick={() =>
                      void run(
                        () => exportReferenceGroupPackage(g.id),
                        (path) => (path ? t("groups.exported", { path: String(path) }) : null),
                      )
                    }
                  >
                    {t("groups.export")}
                  </MenuItem>
                  <MenuSeparator />
                </>
              )}
              <MenuItem icon={<Trash2 size={14} />} danger onClick={() => void removeGroup(g)}>
                {t("groups.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu.Root>
        )}
        {onDesk && view && renaming?.id !== g.id && (
          <DeskGroupMembers
            view={view}
            libraryNames={libraryNames}
            label={label}
            onRepin={(memberId) => void run(() => repinGroupMember(memberId))}
            onRemove={(memberId) =>
              void undoable(
                () => removeGroupMember(g.id, memberId),
                () => t("deskPanel.removed"),
              )
            }
          />
        )}
      </motion.li>
    );
  };

  return (
    <section className="reference-groups desk-groups" aria-label={t("groups.label")}>
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
      {all.length === 0 && <p className="desk-groups-empty">{t("groups.empty")}</p>}
      <LayoutGroup>
        <Sections onDesk={lists.onDesk} reduced={reduced}>
          {lists.favorites.length > 0 && (
            <Section id="desk-groups-favorites" title={t("deskPanel.favorites")}>
              {lists.favorites.map((g) => item(g, "favorites"))}
            </Section>
          )}
          {lists.recent.length > 0 && (
            <Section id="desk-groups-recent" title={t("deskPanel.recent")}>
              {lists.recent.map((g) => item(g, "recent"))}
            </Section>
          )}
          {lists.older.length > 0 && (
            <>
              <h3 className="desk-groups-heading">
                <button
                  type="button"
                  className="desk-groups-toggle"
                  aria-expanded={olderOpen}
                  aria-controls="desk-groups-older"
                  onClick={() => setOlderOpen((open) => !open)}
                >
                  <ChevronRight size={12} aria-hidden="true" />
                  <span>{t("deskPanel.older")}</span>
                  <span className="desk-groups-count">{lists.older.length}</span>
                </button>
              </h3>
              {olderOpen && (
                <ul className="desk-groups-list" id="desk-groups-older" aria-label={t("deskPanel.older")}>
                  {lists.older.map((g) => item(g, "older"))}
                </ul>
              )}
            </>
          )}
        </Sections>
      </LayoutGroup>
      <footer className="desk-groups-foot">
        <button type="button" className="k-btn is-sm is-ghost" onClick={() => setImporting(true)}>
          <FolderInput size={13} aria-hidden="true" />
          <span className="k-label">{t("groups.import")}</span>
        </button>
      </footer>
    </section>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <>
      <h3 className="desk-groups-heading" id={id}>
        {title}
      </h3>
      <ul className="desk-groups-list" aria-labelledby={id}>
        {children}
      </ul>
    </>
  );
}

/** 常用与最近的卡片上的前几张缩略图；安全模式下被遮蔽的不显示图。 */
function Thumbs({ groupId, members }: { groupId: string; members: MemberStatus[] }) {
  return (
    <span className="desk-group-thumbs" aria-hidden="true">
      {members.slice(0, 5).map((m) => (
        <span
          key={m.memberId}
          className={`desk-group-thumb${m.state.kind === "available" ? (m.state.sealed ? " is-sealed" : "") : " is-missing"}`}
        >
          {m.state.kind === "available" && !m.state.sealed && (
            <img
              src={
                "libraryId" in m
                  ? thumbnailUrl(`${m.libraryId}/${m.imageId}/128`)
                  : captureUrl(`group/${groupId}/${m.memberId}`)
              }
              alt=""
              draggable={false}
            />
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * 三段与指示块：指示块按桌面上那一项的位置和高度摆，换一项时用 `--t-slow` 加弹簧滑过去
 * （design/ui-system/visual-and-motion.md），跨段也一样。第一次出现、尺寸变化直接到位；桌面空着时不出现。
 */
function Sections({ onDesk, reduced, children }: { onDesk: string | null; reduced: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const placed = useRef<string | null>(null);
  const slidingUntil = useRef(0);
  const place = useCallback(
    (slide: boolean) => {
      const thumb = mark.current;
      const box = root.current;
      const on = onDesk
        ? [...(box?.querySelectorAll<HTMLElement>(".desk-group") ?? [])].find((el) => el.dataset.id === onDesk)
        : undefined;
      if (!thumb || !box) return;
      if (!on) {
        thumb.hidden = true;
        return;
      }
      thumb.style.transition = slide && !reduced ? "" : "none";
      thumb.style.height = `${on.offsetHeight}px`;
      // 按排版位置算，不用 getBoundingClientRect：换段的卡片这时还带着 layout 动画的反向位移。
      let top = 0;
      for (let el: HTMLElement | null = on; el && el !== box; el = el.offsetParent as HTMLElement | null)
        top += el.offsetTop;
      thumb.style.transform = `translateY(${top}px)`;
      thumb.hidden = false;
    },
    [onDesk, reduced],
  );

  useLayoutEffect(() => {
    const slide = placed.current !== null && onDesk !== null && placed.current !== onDesk;
    if (slide) slidingUntil.current = performance.now() + SLIDE_MS;
    // 滑动中又重排（例如成员读回来了）：照样朝新位置滑。
    place(slide || performance.now() < slidingUntil.current);
    if (onDesk !== null) placed.current = onDesk;
  });

  // 卡片随面板宽度、改名、展开成员变高：跟着到位，正在滑时朝新位置滑。
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const observer = new ResizeObserver(() => place(performance.now() < slidingUntil.current));
    observer.observe(box);
    return () => observer.disconnect();
  }, [place]);

  return (
    <div ref={root} className="desk-groups-switch">
      <span ref={mark} className="desk-groups-mark" aria-hidden="true" hidden />
      {children}
    </div>
  );
}
