import { useEffect, useRef, useState } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ContentRating } from "../bindings/ContentRating";
import type { ImageRating } from "../bindings/ImageRating";
import type { FolderNode } from "../bindings/FolderNode";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageEdit } from "../bindings/ImageEdit";
import type { PermanentDeletePreview } from "../bindings/PermanentDeletePreview";
import {
  editImages,
  imageDetail,
  isDeletePreviewStale,
  permanentDelete,
  previewPermanentDelete,
  sidebar,
  workspaceSourceInspection,
  workspaceEditSource,
  workspaceSidebar,
  workspacePreviewSourceDelete,
  workspacePermanentSourceDelete,
} from "../ipc";
import { TagPanel } from "./TagPanel";

type Props = {
  sourceTarget?: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget;
  onSourceChanged?: () => void;
  libraryId: string;
  scope: BrowseScope;
  selected: ReadonlySet<string>;
  onClear: () => void;
  /** 资料库报告列表过期时递增：重新取文件夹列表与详情。 */
  reloadKey: number;
  onError: (message: string) => void;
  /** 安全模式开启时，改成含成人内容的分级会让图被封印：随即取消选择。 */
  safeMode?: boolean;
  /** 词表代次（词表、图片或安全模式变化时递增）：标签面板随之刷新。 */
  generation?: number;
};

const isAdult = (rating: ContentRating | null) =>
  rating === "questionable" || rating === "explicit";

/** 文件夹树摊平成带缩进的选项。 */
function flatten(nodes: FolderNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((n) => [
    { id: n.id, label: `${"　".repeat(depth)}${n.name}` },
    ...flatten(n.children, depth + 1),
  ]);
}

const RATING_LABELS: Record<ContentRating, string> = {
  general: "全年龄",
  sensitive: "轻微敏感",
  questionable: "可疑",
  explicit: "露骨",
};

/** 内容分级：画师选的分级优先于自动分级；选“自动”即退回自动分级。 */
function RatingPicker({
  rating,
  edit,
}: {
  rating: ImageRating;
  edit: (edits: ImageEdit[]) => void;
}) {
  const auto = rating.suggested ? RATING_LABELS[rating.suggested] : "尚未分级";
  return (
    <label className="selection-rating">
      <span>内容分级</span>
      <select
        aria-label="内容分级"
        value={rating.manual ?? ""}
        onChange={(e) => {
          const value = e.target.value as ContentRating | "";
          edit([value ? { kind: "setRating", rating: value } : { kind: "revertRating" }]);
        }}
      >
        <option value="">自动（{auto}）</option>
        {(Object.keys(RATING_LABELS) as ContentRating[]).map((r) => (
          <option key={r} value={r}>
            {RATING_LABELS[r]}
          </option>
        ))}
      </select>
      {rating.manual && <span className="selection-hint">人工修正，重新打标不会覆盖</span>}
    </label>
  );
}

/** 只选中一张时：所在文件夹、内容分级与备注。 */
function Detail({
  detail,
  edit,
  sourceMode = false,
}: {
  detail: ImageDetail;
  edit: (edits: ImageEdit[]) => void;
  sourceMode?: boolean;
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
      {detail.versions.previous && <p className="selection-version">新版本：Eagle 中这张图的内容变了，旧版本仍保留在资料库里</p>}
      {detail.versions.newer.length > 0 && <p className="selection-version">旧版本：Eagle 中这张图的内容后来变了，新版本另存为一张图</p>}
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
      {sourceMode && detail.folders.length > 0 && <div className="selection-actions">{detail.folders.map((folder) =>
        <button type="button" key={folder.id} onClick={() => edit([{ kind: "removeFromFolder", folderId: folder.id }])}>移出「{folder.name}」</button>,
      )}</div>}
      <RatingPicker rating={detail.rating} edit={edit} />
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

/**
 * 永久删除的确认（#67）：列出会受影响的参考组；没有时直接确认。执行时预览已过期（回收站、
 * 参考组或安全模式变了）就重新预览，让画师看过新的影响再确认。
 */
function PermanentDeleteConfirm({
  libraryId,
  sourceTarget,
  safeMode = false,
  ids,
  onDone,
  onCancel,
  onError,
}: {
  libraryId: string;
  ids: string[];
  sourceTarget?: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget;
  safeMode?: boolean;
  onDone: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [preview, setPreview] = useState<PermanentDeletePreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([libraryId, ids, sourceTarget, safeMode]);
  const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => { currentKey.current = key; return () => { currentKey.current = ""; }; }, [key]);

  const load = () =>
    (sourceTarget ? workspacePreviewSourceDelete(sourceTarget, safeMode) : previewPermanentDelete(libraryId, ids)).then(
      (value) => { if (currentKey.current === key) setPreview(value); }, (e) => {
      if (currentKey.current !== key) return;
      onError(String(e));
      onCancel();
    });

  useEffect(() => {
    setPreview(null);
    setChanged(false);
    void load();
  }, [libraryId, key]);

  const confirm = () => {
    if (!preview) return;
    setBusy(true);
    (sourceTarget ? workspacePermanentSourceDelete(sourceTarget, safeMode, preview.token) : permanentDelete(libraryId, preview.imageIds, preview.token)).then(
      () => {
        if (currentKey.current !== key) return;
        setBusy(false);
        onDone();
      },
      (e) => {
        if (currentKey.current !== key) return;
        setBusy(false);
        if (isDeletePreviewStale(e)) {
          setChanged(true);
          setPreview(null);
          void load();
        } else {
          onError(String(e));
        }
      },
    );
  };

  if (!preview) return <p className="selection-hint">正在核对参考组…</p>;
  return (
    <div className="permanent-delete" role="alertdialog" aria-label="永久删除">
      {changed && <p className="selection-hint">回收站或参考组刚有变化，已按最新情况重新列出。</p>}
      <p>永久删除这 {preview.imageIds.length} 张图？原图与整理结果都会删除，无法恢复。</p>
      {preview.groups.length > 0 && (
        <>
          <p>以下参考组用到了这些图。删除后成员与布局保留，缺失的图会标出来：</p>
          <ul aria-label="受影响的参考组">
            {preview.groups.map((g) => (
              <li key={g.groupId}>
                {g.name}（{g.imageIds.length} 张）
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="selection-actions">
        <button type="button" disabled={busy} onClick={confirm}>
          确认永久删除
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/** 选中参考图后的整理操作：放入或移出文件夹、标签决定、删除或恢复；只选一张时还能写备注。 */
export function SelectionPanel({
  libraryId,
  scope,
  selected,
  onClear,
  reloadKey,
  onError,
  safeMode = false,
  generation = 0,
  sourceTarget,
  onSourceChanged,
}: Props) {
  const ids = [...selected];
  const single = ids.length === 1 ? ids[0] : null;
  const [folders, setFolders] = useState<{ id: string; label: string }[]>([]);
  const [detail, setDetail] = useState<ImageDetail | null>(null);
  const [purging, setPurging] = useState(false);
  const selectionKey = ids.join("\n");
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const requestKey = JSON.stringify([libraryId, selectionKey, safeMode, sourceTarget]);
  const currentKey = useRef(requestKey);
  currentKey.current = requestKey;
  useEffect(() => { currentKey.current = requestKey; return () => { currentKey.current = ""; }; }, [requestKey]);
  // 选择变了就收起永久删除的确认。
  useEffect(() => setPurging(false), [selectionKey]);

  useEffect(() => {
    let alive = true;
    (sourceTarget ? workspaceSidebar(libraryId, safeMode) : sidebar(libraryId)).then(
      (s) => alive && setFolders(flatten(s.folders)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [libraryId, reloadKey, safeMode, requestKey, sourceRefresh]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    // Delete confirmation owns the selection now; listStale must not start another detail read.
    if (single && !purging)
      (sourceTarget ? workspaceSourceInspection(sourceTarget, safeMode, "zh-CN").then((value) => value.detail) : imageDetail(libraryId, single)).then(
        (d) => alive && setDetail(d),
        (e) => alive && onError(String(e)),
      );
    return () => {
      alive = false;
    };
  }, [libraryId, single, reloadKey, onError, purging, requestKey, sourceRefresh]);

  const edit = (edits: ImageEdit[], clear = false) => {
    if (sourceTarget) {
      return workspaceEditSource(sourceTarget, safeMode, edits).then(() => {
        if (currentKey.current !== requestKey) return;
        const sealed = safeMode && edits.some((e) => (e.kind === "setRating" && isAdult(e.rating)) ||
          (e.kind === "revertRating" && isAdult(detail?.rating.suggested ?? null)));
        if (clear || sealed) onClear(); else setSourceRefresh((n) => n + 1);
        onSourceChanged?.();
      }, (e) => { if (currentKey.current === requestKey) onError(String(e)); });
    }
    return editImages(libraryId, ids, edits).then(
      (details) => {
        if (currentKey.current !== requestKey) return;
        if (single && details[0]) setDetail(details[0]);
        const sealed = safeMode && details.some((d) => isAdult(d.rating.effective));
        if (clear || sealed) onClear();
      },
      (e) => { if (currentKey.current === requestKey) onError(String(e)); },
    );
  };

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
          <>
            <button type="button" onClick={() => void edit([{ kind: "restore" }], true)}>
              恢复
            </button>
            <button type="button" onClick={() => setPurging(true)}>
              永久删除…
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void edit([{ kind: "delete" }], true)}>
            删除
          </button>
        )}
        <button type="button" onClick={onClear}>
          取消选择
        </button>
      </div>
      {purging && scope.kind === "trash" && (
        <PermanentDeleteConfirm
          libraryId={libraryId}
          ids={ids}
          sourceTarget={sourceTarget}
          safeMode={safeMode}
          onDone={() => {
            setPurging(false);
            onClear();
          }}
          onCancel={() => setPurging(false)}
          onError={onError}
        />
      )}
      {!purging && <TagPanel sourceTarget={sourceTarget} libraryId={libraryId} ids={ids} safe={safeMode} generation={generation + sourceRefresh} onError={onError} />}
      {!purging && detail && <Detail key={detail.id} sourceMode={!!sourceTarget} detail={detail} edit={(e) => void edit(e)} />}
    </aside>
  );
}
