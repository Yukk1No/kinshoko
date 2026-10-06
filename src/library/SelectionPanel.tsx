import { useEffect, useState } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { FolderNode } from "../bindings/FolderNode";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageEdit } from "../bindings/ImageEdit";
import { editImages, imageDetail, sidebar } from "../ipc";

type Props = {
  scope: BrowseScope;
  selected: ReadonlySet<string>;
  onClear: () => void;
  /** 资料库报告列表过期时递增：重新取文件夹列表与详情。 */
  reloadKey: number;
  onError: (message: string) => void;
};

/** 文件夹树摊平成带缩进的选项。 */
function flatten(nodes: FolderNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((n) => [
    { id: n.id, label: `${"　".repeat(depth)}${n.name}` },
    ...flatten(n.children, depth + 1),
  ]);
}

/** 只选中一张时：所在文件夹与备注。 */
function Detail({
  detail,
  edit,
}: {
  detail: ImageDetail;
  edit: (edits: ImageEdit[]) => void;
}) {
  const { manual, sources } = detail.note;
  const sourceText = sources.map((s) => s.text).join("\n");
  const saved = manual ?? sourceText;
  const [draft, setDraft] = useState(saved);
  // 保存或退回后备注变了，草稿跟着换。在渲染中比较而不用 effect：effect 晚一拍执行时
  // 会冲掉刚打的字。
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setDraft(saved);
  }

  return (
    <div className="selection-detail">
      <p>{detail.originalName} · 收集于 {new Date(detail.collectedAt).toLocaleString("zh-CN")}</p>
      {detail.sourceLinks?.length > 0 && (
        <ul aria-label="来源链接">
          {detail.sourceLinks.map((url) => (
            <li key={url}>{/^https?:\/\//i.test(url)
              ? <a href={url} target="_blank" rel="noreferrer">{url}</a>
              : <span>{url}</span>}</li>
          ))}
        </ul>
      )}
      <p className="selection-folders">
        {detail.folders.length
          ? `所在文件夹：${detail.folders.map((f) => f.name).join("、")}`
          : "不在任何文件夹里"}
      </p>
      <label className="selection-note">
        <span>备注{manual === null && sources.length > 0 ? "（来自来源）" : ""}</span>
        <textarea value={draft} rows={3} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <div className="selection-actions">
        <button
          type="button"
          disabled={draft === saved}
          onClick={() => edit([{ kind: "setNote", text: draft }])}
        >
          保存备注
        </button>
        <button
          type="button"
          disabled={manual === null}
          title={sources.length ? "改回来源提供的备注" : "来源没有提供备注，退回后备注为空"}
          onClick={() => edit([{ kind: "revertNote" }])}
        >
          退回来源备注
        </button>
      </div>
    </div>
  );
}

/** 选中参考图后的整理操作：放入或移出文件夹、删除或恢复；只选一张时还能写备注。 */
export function SelectionPanel({ scope, selected, onClear, reloadKey, onError }: Props) {
  const ids = [...selected];
  const single = ids.length === 1 ? ids[0] : null;
  const [folders, setFolders] = useState<{ id: string; label: string }[]>([]);
  const [detail, setDetail] = useState<ImageDetail | null>(null);

  useEffect(() => {
    let alive = true;
    sidebar().then(
      (s) => alive && setFolders(flatten(s.folders)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    if (single)
      imageDetail(single).then(
        (d) => alive && setDetail(d),
        (e) => alive && onError(String(e)),
      );
    return () => {
      alive = false;
    };
  }, [single, reloadKey, onError]);

  const edit = (edits: ImageEdit[], clear = false) =>
    editImages(ids, edits).then(
      (details) => {
        if (single && details[0]) setDetail(details[0]);
        if (clear) onClear();
      },
      (e) => onError(String(e)),
    );

  return (
    <aside className="selection" aria-label="已选参考图">
      <div className="selection-actions">
        <span className="selection-count">已选 {ids.length} 张</span>
        <select
          aria-label="放入文件夹"
          value=""
          disabled={!folders.length}
          onChange={(e) => {
            const folderId = e.target.value;
            if (folderId) void edit([{ kind: "addToFolder", folderId }]);
          }}
        >
          <option value="">{folders.length ? "放入文件夹…" : "还没有文件夹"}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        {scope.kind === "folder" && (
          <button
            type="button"
            onClick={() => void edit([{ kind: "removeFromFolder", folderId: scope.id }], true)}
          >
            移出此文件夹
          </button>
        )}
        {scope.kind === "trash" ? (
          <button type="button" onClick={() => void edit([{ kind: "restore" }], true)}>
            恢复
          </button>
        ) : (
          <button type="button" onClick={() => void edit([{ kind: "delete" }], true)}>
            删除
          </button>
        )}
        <button type="button" onClick={onClear}>
          取消选择
        </button>
      </div>
      {detail && <Detail key={detail.id} detail={detail} edit={(e) => void edit(e)} />}
    </aside>
  );
}
