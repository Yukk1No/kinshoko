import { useCallback, useEffect, useState } from "react";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { MemberStatus } from "../bindings/MemberStatus";
import type { ReferenceGroup } from "../bindings/ReferenceGroup";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import {
  deleteReferenceGroup,
  exportReferenceGroupPackage,
  importReferenceGroupPackage,
  onReferenceGroupsChanged,
  openReferenceGroup,
  referenceGroup,
  referenceGroups,
  registeredLibraries,
  removeGroupMember,
  renameReferenceGroup,
  savePinsToGroup,
  saveReferenceGroup,
} from "../ipc";

function memberState(status: MemberStatus): string {
  switch (status.state.kind) {
    case "available":
      return status.state.sealed ? "安全模式下原位遮蔽" : "可用";
    case "unavailable":
      return status.state.message;
  }
}

/**
 * 参考组（#66）：把桌面上的资料库钉图存成参考组，打开参考组把成员按原来的局部与摆放钉回桌面。
 * 参考组独立于资料库保存，成员可来自多个资料库；资料库不可用、图已删除的成员保留布局并写出原因，
 * 安全模式下被封印的成员在钉图上原位遮蔽。
 *
 * 参考组包（#68）：导出时带上所用原图与整理信息快照，可带到别的电脑；导入时原图进当前资料库
 * （`libraryId`），另存为新的参考组。
 */
export function ReferenceGroupsPanel({ libraryId }: { libraryId?: string | null }) {
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [libraryNames, setLibraryNames] = useState<Map<string, string>>(new Map());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReferenceGroupView | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const reload = useCallback(() => {
    referenceGroups()
      .then(setGroups)
      .catch((e) => setError(String(e)));
    registeredLibraries()
      .then((list) => setLibraryNames(new Map(list.map((r) => [r.library.id, r.library.name]))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const unlisten = onReferenceGroupsChanged(reload);
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [reload]);

  // 展开的参考组变了（存回、移出成员）时重新核对成员。
  useEffect(() => {
    if (!expanded || !groups) return;
    const current = groups.find((g) => g.id === expanded.group.id);
    if (!current || current.problem) setExpanded(null);
    else if (current.updatedAt !== expanded.group.updatedAt)
      referenceGroup(current.id).then(setExpanded, () => setExpanded(null));
  }, [groups, expanded]);

  const run = async (action: () => Promise<unknown>, done?: (value: unknown) => string | null) => {
    setError(null);
    setNotice(null);
    try {
      const value = await action();
      setNotice(done?.(value) ?? null);
    } catch (e) {
      setError(String(e));
    }
  };

  const libraries = (ids: string[]) => ids.map((id) => libraryNames.get(id) ?? "未登记的资料库").join("、");

  const toggleMembers = (id: string) =>
    expanded?.group.id === id ? setExpanded(null) : void run(() => referenceGroup(id).then(setExpanded));

  return (
    <section className="reference-groups" aria-label="参考组">
      <header className="reference-groups-bar">
        <h2>参考组</h2>
        <input
          aria-label="新参考组名称"
          placeholder="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() =>
            void run(
              () => saveReferenceGroup(name),
              () => {
                setName("");
                return "已把桌面上的资料库钉图存为参考组";
              },
            )
          }
        >
          把桌面钉图存为参考组
        </button>
        <button
          type="button"
          disabled={!libraryId}
          title={libraryId ? "原图导入当前资料库，另存为新的参考组" : "先打开一个资料库"}
          onClick={() =>
            libraryId &&
            void run(
              () => importReferenceGroupPackage(libraryId),
              (group) =>
                group ? `已导入参考组「${(group as ReferenceGroup).name}」，原图已收进当前资料库` : null,
            )
          }
        >
          导入参考组包
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {groups && groups.length === 0 && (
        <p className="reference-groups-empty">
          还没有参考组。把资料库里的整图或局部钉到桌面、摆好，再在这里存为参考组；截图要先收藏进资料库。
        </p>
      )}
      <ul className="reference-groups-list">
        {groups?.map((g) => (
          <li key={g.id} className="reference-group" data-id={g.id}>
            {renaming?.id === g.id ? (
              <span className="reference-group-name">
                <input
                  aria-label="参考组名称"
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: g.id, name: e.target.value })}
                />
                <button
                  type="button"
                  disabled={!renaming.name.trim()}
                  onClick={() => void run(() => renameReferenceGroup(g.id, renaming.name), () => (setRenaming(null), null))}
                >
                  保存名称
                </button>
                <button type="button" onClick={() => setRenaming(null)}>
                  取消
                </button>
              </span>
            ) : (
              <strong className="reference-group-name">{g.name}</strong>
            )}
            {g.problem ? (
              <span className="reference-group-problem">{g.problem}</span>
            ) : (
              <span className="reference-group-meta">
                {g.memberCount} 个成员 · {libraries(g.libraryIds)}
              </span>
            )}
            <span className="reference-group-actions">
              {!g.problem && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => openReferenceGroup(g.id),
                        (n) => (n === 0 ? "成员都已在桌面上" : `已钉出 ${String(n)} 个成员`),
                      )
                    }
                  >
                    钉到桌面
                  </button>
                  <button
                    type="button"
                    title="来自这个参考组的钉图更新原成员，其他资料库钉图加为新成员"
                    onClick={() => void run(() => savePinsToGroup(g.id), () => "已把桌面钉图存进这个参考组")}
                  >
                    存入桌面钉图
                  </button>
                  <button type="button" aria-expanded={expanded?.group.id === g.id} onClick={() => toggleMembers(g.id)}>
                    成员
                  </button>
                  <button type="button" onClick={() => setRenaming({ id: g.id, name: g.name })}>
                    重命名
                  </button>
                  <button
                    type="button"
                    title="带上所用原图与标签、备注、来源的快照，可带到别的电脑"
                    onClick={() =>
                      void run(
                        () => exportReferenceGroupPackage(g.id),
                        (path) => (path ? `已导出参考组包：${String(path)}` : null),
                      )
                    }
                  >
                    导出参考组包
                  </button>
                </>
              )}
              {deleting === g.id ? (
                <>
                  <button
                    type="button"
                    onClick={() => void run(() => deleteReferenceGroup(g.id), () => (setDeleting(null), null))}
                  >
                    确认删除
                  </button>
                  <button type="button" onClick={() => setDeleting(null)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setDeleting(g.id)}>
                  删除
                </button>
              )}
            </span>
            {expanded?.group.id === g.id && (
              <ol className="reference-group-members">
                {expanded.members.map((m, i) => {
                  const member = expanded.group.members[i];
                  const crop = member?.crop;
                  return (
                    <li
                      key={m.memberId}
                      className={m.state.kind === "unavailable" ? "reference-group-member-unavailable" : undefined}
                    >
                      <span>
                        {libraryNames.get(m.libraryId) ?? "未登记的资料库"} ·{" "}
                        {crop ? `局部 ${crop.width}×${crop.height}` : "整图"}
                      </span>
                      <span>{memberState(m)}</span>
                      <button
                        type="button"
                        onClick={() => void run(() => removeGroupMember(g.id, m.memberId))}
                      >
                        移出
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
