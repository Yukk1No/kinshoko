import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMoment } from "../i18n/format";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Link2, ShieldCheck, Undo2 } from "lucide-react";
import { Segmented } from "../ui/Segmented";
import type { ContentRating } from "../bindings/ContentRating";
import type { ImageRating } from "../bindings/ImageRating";
import type { FolderNode } from "../bindings/FolderNode";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageEdit } from "../bindings/ImageEdit";
import type { PermanentDeletePreview } from "../bindings/PermanentDeletePreview";
import {
  editImages,
  isDeletePreviewStale,
  permanentDelete,
  previewEmptyTrash,
  previewPermanentDelete,
  workspaceImage,
} from "../ipc";
import { TagPanel } from "./TagPanel";

type Props = {
  libraryId: string;
  selected: ReadonlySet<string>;
  onClear: () => void;
  /** 资料库报告列表过期时递增：重新取文件夹列表与详情。 */
  reloadKey: number;
  onError: (error: unknown) => void;
  /** 安全模式开启时，改成含成人内容的分级会让图被封印：随即取消选择。 */
  safeMode?: boolean;
  /** 词表代次（词表、图片或安全模式变化时递增）：标签面板随之刷新。 */
  generation?: number;
};

const isAdult = (rating: ContentRating | null) =>
  rating === "questionable" || rating === "explicit";

/** 文件夹树摊平成带缩进的选项。 */
export function flattenFolders(nodes: FolderNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((n) => [
    // 全角空格缩进，与文件夹名对齐，不是界面文案。
    { id: n.id, label: `${"\u3000".repeat(depth)}${n.name}` },
    ...flattenFolders(n.children, depth + 1),
  ]);
}

const RATINGS: ContentRating[] = ["general", "sensitive", "questionable", "explicit"];

/** 内容分级：画师选的分级优先于自动分级；“改回自动”即退回自动分级。 */
function RatingPicker({
  rating,
  edit,
}: {
  rating: ImageRating;
  edit: (edits: ImageEdit[]) => void;
}) {
  const { t } = useTranslation(["inspector", "common"]);
  const auto = rating.suggested ? t(`common:rating.${rating.suggested}`) : t("rating.unrated");
  return (
    <section className="insp-sec selection-rating" aria-label={t("rating.label")}>
      <h4><ShieldCheck size={13} aria-hidden="true" />{t("rating.title")}</h4>
      <Segmented<ContentRating> label={t("rating.label")} className="insp-rate" value={rating.manual}
        onChange={(value) => edit([{ kind: "setRating", rating: value }])}
        options={RATINGS.map((r) => ({ value: r, label: t(`common:rating.${r}`) }))} />
      {rating.manual
        ? <p className="insp-hint">{t("rating.manual")}
          <button type="button" className="k-btn is-ghost is-sm" onClick={() => edit([{ kind: "revertRating" }])}><Undo2 size={12} aria-hidden="true" /><span className="k-label">{t("rating.revert", { auto })}</span></button></p>
        : <p className="insp-hint">{t("rating.auto", { auto })}</p>}
    </section>
  );
}

/** 只选中一张时：所在文件夹、内容分级与备注。 */
function Detail({
  detail,
  edit,
  stale = false,
}: {
  detail: ImageDetail;
  edit: (edits: ImageEdit[]) => void;
  /** 已选中别的图、它的详情还没到：先留着这张的，但不能操作。 */
  stale?: boolean;
}) {
  const { t } = useTranslation("inspector");
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
    <div className="selection-detail" aria-busy={stale} inert={stale}>
      <div className="insp-file">
        <div className="insp-file-name" title={detail.originalName}>{detail.originalName}</div>
        <div className="insp-file-meta k-parts"><span>{detail.width} × {detail.height}</span><span>{t("file.collectedAt", { at: formatMoment(detail.collectedAt) })}</span></div>
      </div>
      {detail.versions.previous && <p className="selection-version">{t("file.newVersion")}</p>}
      {detail.versions.newer.length > 0 && <p className="selection-version">{t("file.oldVersion")}</p>}
      <RatingPicker rating={detail.rating} edit={edit} />
      <section className="insp-sec selection-folders" aria-label={t("folders.label")}>
        <h4>{t("folders.title")}</h4>
        {detail.folders.length
          ? <ul className="insp-chips">{detail.folders.map((folder) => <li key={folder.id} className="insp-chip"><span className="k-label">{folder.name}</span></li>)}</ul>
          : <p className="insp-hint">{t("folders.none")}</p>}
      </section>
      {/* 备注（#98）：字段用改版样式；有未保存的改动才出现“保存”，有自己写的备注才能“用来源的”。 */}
      <section className="insp-sec k-note">
        <label className="selection-note">
          <span className="insp-h">{manual === null && sources.length > 0 ? t("note.fromSource") : t("note.title")}</span>
          <textarea className="k-textarea" aria-label={t("note.title")} placeholder={t("note.placeholder")} value={draft} rows={3} onChange={(e) => setDraft(e.target.value)} />
        </label>
        {(draft !== saved || manual !== null) && <div className="selection-actions k-note-acts">
          {draft !== saved && <button
            type="button"
            className="k-btn is-sm is-quiet"
            aria-label={t("note.saveLabel")}
            onClick={() => edit([{ kind: "setNote", text: draft }])}
          >
            <span className="k-label">{t("note.save")}</span>
          </button>}
          <button
            type="button"
            className="k-btn is-sm is-ghost"
            aria-label={t("note.revertLabel")}
            disabled={manual === null}
            title={sources.length ? t("note.revertTitle") : t("note.revertEmptyTitle")}
            onClick={() => edit([{ kind: "revertNote" }])}
          >
            <span className="k-label">{t("note.revert")}</span>
          </button>
        </div>}
      </section>
      {detail.sourceLinks?.length > 0 && (
        <ul className="insp-links" aria-label={t("links")}>
          {detail.sourceLinks.map((url) => (
            <li key={url}><Link2 size={13} aria-hidden="true" />{/^https?:\/\//i.test(url)
              ? <a href={url} target="_blank" rel="noreferrer">{url}</a>
              : <span>{url}</span>}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 永久删除的确认（#67）：列出会受影响的参考组；没有时直接确认。执行时预览已过期（回收站、
 * 参考组或安全模式变了）就重新预览，让画师看过新的影响再确认。
 * emptyTrash：清空这个图库的回收站（#114），预览回收站里的全部图，之后走同一永久删除。
 */
export function PermanentDeleteConfirm({
  libraryId,
  safeMode = false,
  ids,
  emptyTrash,
  onDone,
  onCancel,
  onError,
}: {
  libraryId: string;
  ids: string[];
  emptyTrash?: { libraryName: string };
  safeMode?: boolean;
  onDone: () => void;
  onCancel: () => void;
  onError: (error: unknown) => void;
}) {
  const [preview, setPreview] = useState<PermanentDeletePreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([libraryId, ids, safeMode, Boolean(emptyTrash)]);
  const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => { currentKey.current = key; return () => { currentKey.current = ""; }; }, [key]);

  const load = () =>
    (emptyTrash ? previewEmptyTrash(libraryId) : previewPermanentDelete(libraryId, ids)).then(
      (value) => { if (currentKey.current === key) setPreview(value); }, (e) => {
      if (currentKey.current !== key) return;
      onError(e);
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
    permanentDelete(libraryId, preview.imageIds, preview.token).then(
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
          onError(e);
        }
      },
    );
  };

  const { t } = useTranslation("wall", { keyPrefix: "purge" });
  const title = emptyTrash ? t("emptyTrash") : t("title");
  // 提醒对话框挂在 body 上：详情面板收起（inert）时也能看到并操作（#98）。
  return (
    <AlertDialog.Root open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="k-backdrop" />
        <AlertDialog.Popup className="k-dialog is-alert permanent-delete" aria-label={title}>
          <AlertDialog.Title className="k-dialog-title">{title}</AlertDialog.Title>
          {!preview ? <p className="k-dialog-desc" role="status">{t("checking")}</p> : <>
            {changed && <p className="k-set-note" role="status">{t("changed")}</p>}
            <AlertDialog.Description className="k-dialog-desc">{emptyTrash
              ? t("confirmEmptyTrash", { library: emptyTrash.libraryName, count: preview.imageIds.length })
              : t("confirmCount", { count: preview.imageIds.length })}</AlertDialog.Description>
            {preview.groups.length > 0 && (
              <>
                <p className="k-dialog-desc">{t("groupsIntro")}</p>
                <ul className="permanent-delete-groups" aria-label={t("groupsLabel")}>
                  {preview.groups.map((g) => (
                    <li key={g.groupId}>
                      {t("groupCount", { name: g.name, count: g.imageIds.length })}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>}
          <div className="k-dialog-foot">
            <span className="k-grow" />
            <AlertDialog.Close className="k-btn" disabled={busy}><span className="k-label">{t("cancel")}</span></AlertDialog.Close>
            <button type="button" className="k-btn is-danger" disabled={busy || !preview || preview.imageIds.length === 0} onClick={confirm}>
              <span className="k-label">{emptyTrash ? t("emptyTrash") : t("confirm")}</span>
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** 选中参考图的详情：标签、分级、所在文件夹与备注；移动、删除这些操作在图片墙的右键菜单与悬浮栏里。 */
export function SelectionPanel({
  libraryId,
  selected,
  onClear,
  reloadKey,
  onError,
  safeMode = false,
  generation = 0,
}: Props) {
  const { t } = useTranslation("inspector");
  const ids = [...selected];
  const single = ids.length === 1 ? ids[0] : null;
  // 读到的详情记着它属于哪一次读取：切换选中图时先留着上一张的（不可操作），新的到了再换（#158）。
  const [loaded, setLoaded] = useState<{ key: string; detail: ImageDetail } | null>(null);
  const [failed, setFailed] = useState(false);
  const selectionKey = ids.join("\n");
  const requestKey = JSON.stringify([libraryId, selectionKey, safeMode]);
  const currentKey = useRef(requestKey);
  currentKey.current = requestKey;
  useEffect(() => { currentKey.current = requestKey; return () => { currentKey.current = ""; }; }, [requestKey]);

  const detailKey = JSON.stringify([requestKey, reloadKey]);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (!single) {
      setLoaded(null);
      return;
    }
    workspaceImage(libraryId, single).then(
      (d) => alive && setLoaded({ key: detailKey, detail: d }),
      (e) => { if (alive) { setLoaded(null); setFailed(true); onError(e); } },
    );
    return () => {
      alive = false;
    };
  }, [libraryId, single, reloadKey, onError, detailKey]);
  const detail = loaded?.detail ?? null;
  const stale = loaded?.key !== detailKey;

  const edit = (edits: ImageEdit[]) =>
    editImages(libraryId, ids, edits).then(
      (details) => {
        if (currentKey.current !== requestKey) return;
        if (single && details[0]) setLoaded({ key: detailKey, detail: details[0] });
        if (safeMode && details.some((d) => isAdult(d.rating.effective))) onClear();
      },
      (e) => { if (currentKey.current === requestKey) onError(e); },
    );

  return (
    <div className="selection" aria-label={t("selection.label")}>
      {/* 标签面板保持在原位置（编辑中的输入不因详情重读而重置）；详情面板用 CSS order 把文件名排在它前面。 */}
      {!failed && <TagPanel libraryId={libraryId} ids={ids} safe={safeMode} generation={generation} onError={onError} />}
      {detail && <Detail key={detail.id} detail={detail} stale={stale} edit={(e) => void edit(e)} />}
    </div>
  );
}
