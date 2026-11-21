import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, X } from "lucide-react";
import type { GroupMember } from "../bindings/GroupMember";
import type { MemberStatus } from "../bindings/MemberStatus";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import { formatMoment } from "../i18n/format";
import { captureUrl, thumbnailUrl } from "../ipc";
import { Tip } from "../ui/Tip";
import { localDay } from "./groupLabel";

type Entry = { member: GroupMember; status: MemberStatus; added: number };

const closed = (e: Entry) => e.member.pinned === false;

/** 成员按添加日期分段，早的在前；每段里照参考组里的先后（钉着、已关闭都不挪位置）。 */
export function memberDays(entries: Entry[]): Array<{ day: string; at: number; entries: Entry[] }> {
  const days = new Map<string, { day: string; at: number; entries: Entry[] }>();
  for (const entry of entries) {
    const day = localDay(entry.added);
    const bucket = days.get(day) ?? { day, at: entry.added, entries: [] };
    bucket.entries.push(entry);
    days.set(day, bucket);
  }
  return [...days.values()].sort((a, b) => a.at - b.at);
}

function entriesOf(view: ReferenceGroupView): Entry[] {
  return view.group.members.flatMap((member, i) => {
    const status = view.members[i];
    return status ? [{ member, status, added: member.addedAt ?? view.group.createdAt }] : [];
  });
}

/**
 * 桌面上那组的成员（#592，#588 11-19 晚）：缩略图按添加日期分段。收藏的组每张留在原位，已关闭的变淡；
 * 没收藏的组只列钉着的，已关闭的折进底下一行“已关闭 N 张”（刚关的在前）。单击已关闭的钉回，
 * 单击钉着的把那张钉图提到最前；悬停右上角可移出。一张都没钉着时顶上给“全部钉上”。
 */
export function DeskGroupMembers({
  view,
  favorite,
  libraryNames,
  label,
  onRepin,
  onShow,
  onRepinAll,
  onRemove,
  onSplit,
}: {
  view: ReferenceGroupView;
  favorite: boolean;
  libraryNames: Map<string, string>;
  label: string;
  onRepin: (memberId: string) => void;
  onShow: (memberId: string) => void;
  onRepinAll: () => void;
  onRemove: (memberId: string) => void;
  /** 较新的一段（不是最早那天）移到新参考组（#595）。 */
  onSplit: (day: string) => void;
}) {
  const { t } = useTranslation("desktop");
  const all = entriesOf(view);
  const none = all.length > 0 && all.every(closed);
  const [unfolded, setUnfolded] = useState(false);
  const shown = favorite || none ? all : all.filter((e) => !closed(e));
  const folded =
    favorite || none ? [] : all.filter(closed).toSorted((a, b) => (b.member.closedAt ?? 0) - (a.member.closedAt ?? 0));
  const days = memberDays(shown);
  const split = days.length > 1;

  const tile = ({ member, status }: Entry) => {
    const name =
      "libraryId" in status
        ? (libraryNames.get(status.libraryId) ?? t("groups.unregisteredLibrary"))
        : t("groups.captureMember");
    const isClosed = member.pinned === false;
    const state = status.state;
    const thumb = (
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
      <li key={member.id} className={`desk-group-tile${isClosed ? " is-unpinned" : ""}`}>
        <Tip label={t(isClosed ? "deskPanel.repin" : "deskPanel.bringToFront")}>
          <button
            type="button"
            className="desk-group-tile-body"
            aria-label={t(isClosed ? "deskPanel.repinLabel" : "deskPanel.bringToFrontLabel", { name })}
            onClick={() => (isClosed ? onRepin(member.id) : onShow(member.id))}
          >
            {thumb}
          </button>
        </Tip>
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
  };

  return (
    <div className="desk-group-members" aria-label={t("groups.membersLabel", { name: label })} role="group">
      {none && (
        <button type="button" className="k-btn is-sm desk-group-repin-all" onClick={onRepinAll}>
          {t("deskPanel.repinAll")}
        </button>
      )}
      {days.map(({ day, at, entries }, index) => (
        <section
          key={day}
          className="desk-group-day"
          aria-label={split ? formatMoment(at, { time: false }) : undefined}
        >
          {split && (
            <div className="desk-group-day-head">
              <h4>{formatMoment(at, { time: false })}</h4>
              {index > 0 && (
                <button type="button" className="k-btn is-sm is-quiet desk-group-split" onClick={() => onSplit(day)}>
                  {t("deskPanel.split")}
                </button>
              )}
            </div>
          )}
          <ul className="desk-group-tiles">{entries.map(tile)}</ul>
        </section>
      ))}
      {folded.length > 0 && (
        <section className="desk-group-closed">
          <button
            type="button"
            className="desk-group-closed-toggle"
            aria-expanded={unfolded}
            onClick={() => setUnfolded((v) => !v)}
          >
            <span className="desk-groups-chevron" aria-hidden="true">
              <ChevronRight size={14} />
            </span>
            {t("deskPanel.closedCount", { count: folded.length })}
          </button>
          {unfolded && <ul className="desk-group-tiles">{folded.map(tile)}</ul>}
        </section>
      )}
    </div>
  );
}
