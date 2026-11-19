import { useTranslation } from "react-i18next";
import { FolderPlus, X } from "lucide-react";
import type { GroupMember } from "../bindings/GroupMember";
import type { MemberStatus } from "../bindings/MemberStatus";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import { formatMoment } from "../i18n/format";
import { captureUrl, thumbnailUrl } from "../ipc";
import { Tip } from "../ui/Tip";
import { localDay } from "./groupLabel";

type Entry = { member: GroupMember; status: MemberStatus; added: number };

/** 成员按添加日期分段，早的在前；每段里钉着的在前，其余照参考组里的先后。 */
export function memberDays(view: ReferenceGroupView): Array<{ day: string; at: number; entries: Entry[] }> {
  const days = new Map<string, { day: string; at: number; entries: Entry[] }>();
  view.group.members.forEach((member, i) => {
    const status = view.members[i];
    if (!status) return;
    const added = member.addedAt ?? view.group.createdAt;
    const day = localDay(added);
    const bucket = days.get(day) ?? { day, at: added, entries: [] };
    bucket.entries.push({ member, status, added });
    days.set(day, bucket);
  });
  const pinned = (e: Entry) => (e.member.pinned === false ? 1 : 0);
  return [...days.values()]
    .sort((a, b) => a.at - b.at)
    .map((d) => ({ ...d, entries: d.entries.toSorted((a, b) => pinned(a) - pinned(b)) }));
}

/**
 * 桌面上那组的成员（#592）：缩略图，钉着的在前，没钉着的变淡、点一下钉回；悬停时右上角可移出。
 * 跨几天时按添加日期分段。成员区不限高（待维护者定）。
 */
export function DeskGroupMembers({
  view,
  libraryNames,
  label,
  onRepin,
  onRemove,
  onSplit,
}: {
  view: ReferenceGroupView;
  libraryNames: Map<string, string>;
  label: string;
  onRepin: (memberId: string) => void;
  onRemove: (memberId: string) => void;
  /** 较新的一段（不是最早那天）移到新参考组；`day` 是本地日期 `YYYY-MM-DD`。 */
  onSplit: (day: string) => void;
}) {
  const { t } = useTranslation("desktop");
  const days = memberDays(view);
  const split = days.length > 1;
  return (
    <div className="desk-group-members" aria-label={t("groups.membersLabel", { name: label })} role="group">
      {days.map(({ day, at, entries }, i) => (
        <section
          key={day}
          className="desk-group-day"
          aria-label={split ? formatMoment(at, { time: false }) : undefined}
        >
          {split && (
            <div className="desk-group-day-head">
              <h4>{formatMoment(at, { time: false })}</h4>
              {i > 0 && (
                <button type="button" className="k-btn is-sm is-ghost desk-group-split" onClick={() => onSplit(day)}>
                  <FolderPlus size={13} aria-hidden="true" />
                  <span className="k-label">{t("deskPanel.split")}</span>
                </button>
              )}
            </div>
          )}
          <ul className="desk-group-tiles">
            {entries.map(({ member, status }) => {
              const name =
                "libraryId" in status
                  ? (libraryNames.get(status.libraryId) ?? t("groups.unregisteredLibrary"))
                  : t("groups.captureMember");
              const unpinned = member.pinned === false;
              const state = status.state;
              const tile = (
                <span
                  className={`desk-group-thumb${state.kind === "available" ? (state.sealed ? " is-sealed" : "") : " is-missing"}`}
                >
                  {state.kind === "available" && !state.sealed && (
                    <img
                      src={
                        "libraryId" in status
                          ? thumbnailUrl(`${status.libraryId}/${status.imageId}/128`)
                          : captureUrl(`group/${view.group.id}/${status.memberId}`)
                      }
                      alt=""
                      draggable={false}
                    />
                  )}
                </span>
              );
              return (
                <li key={member.id} className={`desk-group-tile${unpinned ? " is-unpinned" : ""}`}>
                  {unpinned ? (
                    <Tip label={t("deskPanel.repin")}>
                      <button
                        type="button"
                        className="desk-group-tile-body"
                        aria-label={t("deskPanel.repinLabel", { name })}
                        onClick={() => onRepin(member.id)}
                      >
                        {tile}
                      </button>
                    </Tip>
                  ) : (
                    <span className="desk-group-tile-body" role="img" aria-label={name}>
                      {tile}
                    </span>
                  )}
                  <Tip label={t("groups.remove")}>
                    <button
                      type="button"
                      className="desk-group-tile-remove"
                      aria-label={t("deskPanel.removeLabel", { name })}
                      onClick={() => onRemove(member.id)}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </Tip>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
