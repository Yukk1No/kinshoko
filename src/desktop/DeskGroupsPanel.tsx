import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { LayoutGroup, motion } from "motion/react";
import {
  Archive,
  ArchiveRestore,
  FolderInput,
  ListTree,
  MoreHorizontal,
  PackageOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { DeskLists } from "../bindings/DeskLists";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { MemberStatus } from "../bindings/MemberStatus";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import { i18n } from "../i18n/instance";
import {
  archiveReferenceGroup,
  captureUrl,
  deleteReferenceGroup,
  deskReferenceGroups,
  exportReferenceGroupPackage,
  importReferenceGroupPackage,
  newReferenceDesk,
  onReferenceGroupsChanged,
  purgeDeletedReferenceGroup,
  referenceGroup,
  registeredLibraries,
  removeGroupMember,
  renameReferenceGroup,
  restoreReferenceGroup,
  switchReferenceGroup,
  thumbnailUrl,
  unarchiveReferenceGroup,
} from "../ipc";
import { describeCommandError, errorText, isErrorCode, unavailableReasonText } from "../ipc/commandError";
import { SaveDestinationDialog } from "../library/SaveDestination";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { useReducedMotion } from "../ui/reducedMotion";
import { Tip } from "../ui/Tip";
import { useToast } from "../ui/Toast";
import { WarnIcon } from "../ui/WarnIcon";
import { GroupNameForm } from "./GroupNameForm";
import { groupLabel } from "./groupLabel";
import { ReferenceGroupsPanel } from "./ReferenceGroupsPanel";

/** 与 tokens.css 的 `--t-slow` 相同：指示块滑动的时长，滑动中尺寸变了照样滑过去。 */
const SLIDE_MS = 260;

type Desk = { state: "loading" } | { state: "off" } | { state: "on"; lists: DeskLists };

/**
 * 参考组改成桌面（#588）的开关（设置里界面上没有的 `deskReferenceGroups`）开着没有，开着时还有
 * 切换列表与归档。参考组变了（切换、归档、钉上第一张……）时重读。
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
 * 开着时是切换列表加归档（{@link DeskGroupsPanel}，#592）。
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

/** 侧栏标题行右侧的“新参考组”（#592）：换到一张空桌。开关关着时不出现。 */
export function DeskNewGroupButton() {
  const { desk } = useDesk();
  const toast = useToast();
  const { t } = useTranslation("desktop", { keyPrefix: "deskPanel" });
  if (desk.state !== "on") return null;
  return (
    <Tip label={t("newGroup")}>
      <button
        type="button"
        className="k-icon-btn desk-new-group"
        aria-label={t("newGroup")}
        onClick={() => void newReferenceDesk().catch((e) => toast.error(errorText(e)))}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </Tip>
  );
}

function memberState(status: MemberStatus): string {
  switch (status.state.kind) {
    case "available":
      return i18n.t(status.state.sealed ? "desktop:groups.sealed" : "desktop:groups.available");
    case "unavailable":
      return unavailableReasonText(status.state.reason);
  }
}

/**
 * 切换列表在上、归档在下（#592）。单击切换列表里的一项就整桌换成它；归档里的单击不切换，
 * “更多”菜单里取出。桌面上的那一项由一个指示块标出，换一项时滑过去，第一次出现直接到位。
 * 归档、取出时同一张卡片从一段移到另一段。减弱动效时都直接到终态。
 */
export function DeskGroupsPanel({ lists }: { lists: DeskLists }) {
  const { t } = useTranslation("desktop");
  const toast = useToast();
  const reduced = useReducedMotion();
  const [libraryNames, setLibraryNames] = useState<Map<string, string>>(new Map());
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<ReferenceGroupView | null>(null);
  const [removing, setRemoving] = useState<{ groupId: string; memberId: string } | null>(null);
  const [importing, setImporting] = useState(false);
  /** 卡片缩略图用的成员状态，按参考组 id 与更新时间缓存。 */
  const [thumbs, setThumbs] = useState<Map<string, { at: number; members: MemberStatus[] }>>(new Map());

  const all = [...lists.switchList, ...lists.archived];

  useEffect(() => {
    registeredLibraries().then(
      (list) => setLibraryNames(new Map(list.map((r) => [r.library.id, r.library.name]))),
      (e) => toast.error(errorText(e)),
    );
  }, [toast]);

  // 切换列表的缩略图：读一次成员状态；参考组更新后重读。
  // biome-ignore lint/correctness/useExhaustiveDependencies(thumbs.get): 只读它跳过已缓存的；加进依赖会在每张缩略图回来时取消并重发其余请求
  useEffect(() => {
    let alive = true;
    for (const g of lists.switchList) {
      if (g.problem || thumbs.get(g.id)?.at === g.updatedAt) continue;
      referenceGroup(g.id).then(
        (v) => {
          if (alive && v) setThumbs((prev) => new Map(prev).set(g.id, { at: g.updatedAt, members: v.members }));
        },
        () => {},
      );
    }
    return () => {
      alive = false;
    };
  }, [lists.switchList]);

  // 展开的参考组变了（移出成员、桌面上加了钉图）时重新核对成员；不在了就收起。列表里的每个版本只重读一次：
  // 读回来的与列表对不上（例如桌面上的改动还没落盘）时，不再一遍遍地读。
  const recheckedAt = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const current = [...lists.switchList, ...lists.archived].find((g) => g.id === expanded.group.id);
    if (!current || current.problem) setExpanded(null);
    else if (current.updatedAt !== expanded.group.updatedAt) {
      const asked = recheckedAt.current;
      if (asked?.id === current.id && asked.at === current.updatedAt) return;
      recheckedAt.current = { id: current.id, at: current.updatedAt };
      referenceGroup(current.id).then(setExpanded, () => setExpanded(null));
    }
  }, [lists, expanded]);

  const run = async (action: () => Promise<unknown>, done?: (value: unknown) => string | null) => {
    try {
      const value = await action();
      const text = done?.(value);
      if (text) toast.show({ title: text, tone: "success" });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  /** 删除能撤销，所以不先确认：直接删，再给带“撤销”的轻提示。提示关了还没撤销就真正删除暂放的那份。 */
  const removeGroup = async (g: GroupSummary) => {
    let undone = false;
    try {
      const deleted = await deleteReferenceGroup(g.id);
      toast.show({
        title: t("groups.deleted"),
        description: groupLabel(t, g),
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

  const toggleMembers = (id: string) =>
    expanded?.group.id === id ? setExpanded(null) : void run(() => referenceGroup(id).then(setExpanded));

  const item = (g: GroupSummary, archived: boolean) => {
    const label = groupLabel(t, g);
    const onDesk = !archived && g.id === lists.onDesk;
    const members = thumbs.get(g.id)?.members ?? [];
    const head = (
      <>
        {!archived && members.length > 0 && (
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
                        : captureUrl(`group/${g.id}/${m.memberId}`)
                    }
                    alt=""
                    draggable={false}
                  />
                )}
              </span>
            ))}
          </span>
        )}
        <strong className="desk-group-name">{label}</strong>
        {g.problem ? (
          <span className="desk-group-problem">
            <WarnIcon />
            {describeCommandError(g.problem)}
          </span>
        ) : (
          archived && <span className="desk-group-meta">{t("groups.memberCount", { count: g.memberCount })}</span>
        )}
      </>
    );
    return (
      <motion.li
        key={g.id}
        layout="position"
        layoutId={g.id}
        transition={reduced ? { duration: 0 } : undefined}
        className={`desk-group${onDesk ? " is-on" : ""}${archived ? " is-archived" : ""}`}
        data-id={g.id}
      >
        {renaming?.id === g.id ? (
          <GroupNameForm
            title={t("groups.renameTitle")}
            label={t("groups.nameLabel")}
            value={renaming.name}
            primary={false}
            onChange={(value) => setRenaming({ id: g.id, name: value })}
            onCancel={() => setRenaming(null)}
            onSubmit={() =>
              void run(
                () => renameReferenceGroup(g.id, renaming.name),
                () => (setRenaming(null), null),
              )
            }
          />
        ) : archived || g.problem ? (
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
                  {archived ? (
                    <MenuItem
                      icon={<ArchiveRestore size={14} />}
                      onClick={() => void run(() => unarchiveReferenceGroup(g.id))}
                    >
                      {t("deskPanel.unarchive")}
                    </MenuItem>
                  ) : (
                    <MenuItem icon={<Archive size={14} />} onClick={() => void run(() => archiveReferenceGroup(g.id))}>
                      {t("deskPanel.archive")}
                    </MenuItem>
                  )}
                  <MenuItem icon={<ListTree size={14} />} onClick={() => toggleMembers(g.id)}>
                    {expanded?.group.id === g.id ? t("groups.hideMembers") : t("groups.showMembers")}
                  </MenuItem>
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
        {expanded?.group.id === g.id && (
          <ol className="desk-group-members" aria-label={t("groups.membersLabel", { name: label })}>
            {expanded.members.map((m, i) => {
              const crop = expanded.group.members[i]?.crop;
              return (
                <li key={m.memberId} className={m.state.kind === "unavailable" ? "is-unavailable" : undefined}>
                  <span className="k-parts">
                    <span>
                      {"libraryId" in m
                        ? (libraryNames.get(m.libraryId) ?? t("groups.unregisteredLibrary"))
                        : t("groups.captureMember")}
                    </span>
                    <span>
                      {crop ? t("groups.crop", { width: crop.width, height: crop.height }) : t("groups.whole")}
                    </span>
                  </span>
                  <span>
                    {m.state.kind === "unavailable" && <WarnIcon />}
                    {memberState(m)}
                  </span>
                  {/* 截图只存在参考组里：移出就删掉，先确认；图库里的图直接移出。 */}
                  <button
                    type="button"
                    className="k-btn is-sm"
                    onClick={() =>
                      "libraryId" in m
                        ? void run(() => removeGroupMember(g.id, m.memberId))
                        : setRemoving({ groupId: g.id, memberId: m.memberId })
                    }
                  >
                    <span className="k-label">{t("groups.remove")}</span>
                  </button>
                </li>
              );
            })}
          </ol>
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
        <SwitchList onDesk={lists.onDesk} label={t("deskPanel.switchList")} reduced={reduced}>
          {lists.switchList.map((g) => item(g, false))}
        </SwitchList>
        {lists.archived.length > 0 && (
          <>
            <h3 className="desk-groups-heading" id="desk-groups-archived">
              {t("deskPanel.archived")}
            </h3>
            <ul className="desk-groups-list" aria-labelledby="desk-groups-archived">
              {lists.archived.map((g) => item(g, true))}
            </ul>
          </>
        )}
      </LayoutGroup>
      <footer className="desk-groups-foot">
        <button type="button" className="k-btn is-sm is-ghost" onClick={() => setImporting(true)}>
          <FolderInput size={13} aria-hidden="true" />
          <span className="k-label">{t("groups.import")}</span>
        </button>
      </footer>
      <AlertDialog.Root
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="k-backdrop" />
          <AlertDialog.Popup className="k-dialog is-alert">
            <AlertDialog.Title className="k-dialog-title">{t("groups.removeCaptureTitle")}</AlertDialog.Title>
            <AlertDialog.Description className="k-dialog-desc">
              {t("groups.removeCaptureDescription")}
            </AlertDialog.Description>
            <div className="k-dialog-foot">
              <span className="k-grow" />
              <AlertDialog.Close className="k-btn">
                <span className="k-label">{t("groups.cancel")}</span>
              </AlertDialog.Close>
              <button
                type="button"
                className="k-btn is-danger"
                onClick={() => {
                  const { groupId, memberId } = removing!;
                  setRemoving(null);
                  void run(() => removeGroupMember(groupId, memberId));
                }}
              >
                <span className="k-label">{t("groups.removeCaptureConfirm")}</span>
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

/**
 * 切换列表与它的指示块：指示块按桌面上那一项的位置和高度摆，换一项时用 `--t-slow` 加弹簧滑过去
 * （design/ui-system/visual-and-motion.md）。第一次出现、尺寸变化直接到位；桌面是空桌时不出现。
 */
function SwitchList({
  onDesk,
  label,
  reduced,
  children,
}: {
  onDesk: string | null;
  label: string;
  reduced: boolean;
  children: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const placed = useRef<string | null>(null);
  const slidingUntil = useRef(0);
  const place = useCallback(
    (slide: boolean) => {
      const thumb = mark.current;
      const on = onDesk
        ? [...(list.current?.querySelectorAll<HTMLElement>(".desk-group") ?? [])].find((el) => el.dataset.id === onDesk)
        : undefined;
      if (!thumb) return;
      if (!on) {
        thumb.hidden = true;
        return;
      }
      thumb.style.transition = slide && !reduced ? "" : "none";
      thumb.style.height = `${on.offsetHeight}px`;
      thumb.style.transform = `translateY(${on.offsetTop}px)`;
      thumb.hidden = false;
    },
    [onDesk, reduced],
  );

  useLayoutEffect(() => {
    const slide = placed.current !== null && onDesk !== null && placed.current !== onDesk;
    if (slide) slidingUntil.current = performance.now() + SLIDE_MS;
    place(slide);
    if (onDesk !== null) placed.current = onDesk;
  });

  // 卡片随面板宽度、改名、展开成员变高：跟着到位，正在滑时朝新位置滑。
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const observer = new ResizeObserver(() => place(performance.now() < slidingUntil.current));
    observer.observe(root);
    return () => observer.disconnect();
  }, [place]);

  return (
    <div ref={list} className="desk-groups-switch">
      <span ref={mark} className="desk-groups-mark" aria-hidden="true" hidden />
      <ul className="desk-groups-list" aria-label={label}>
        {children}
      </ul>
    </div>
  );
}
