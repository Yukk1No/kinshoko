import { errorText } from "../ipc/commandError";
import { useEffect, useRef, useState } from "react";
import { Name } from "../ui/Name";
import { useTranslation } from "react-i18next";
import { formatMoment } from "../i18n/format";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Folder, Link2, Sparkles, StickyNote } from "lucide-react";
import { Segmented } from "../ui/Segmented";
import type { ContentRating } from "../bindings/ContentRating";
import type { ImageRating } from "../bindings/ImageRating";
import type { FolderNode } from "../bindings/FolderNode";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageEdit } from "../bindings/ImageEdit";
import type { TaggingFailure } from "../bindings/TaggingFailure";
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
import { Tip } from "../ui/Tip";

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

const isAdult = (rating: ContentRating | null) => rating === "questionable" || rating === "explicit";

/** 文件夹树摊平成带缩进的选项。 */
export function flattenFolders(nodes: FolderNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((n) => [
    // 全角空格缩进，与文件夹名对齐，不是界面文案。
    { id: n.id, label: `${"\u3000".repeat(depth)}${n.name}` },
    ...flattenFolders(n.children, depth + 1),
  ]);
}

const RATINGS: ContentRating[] = ["general", "sensitive", "questionable", "explicit"];

/**
 * 内容分级（#518）：指示块始终停在当前生效的那一档，切换时滑过去。星标（“智能”）在模型给的那一档上：分级是自动的，
 * 星跟文字同色；画师改过之后星留在原处、变成图标色，点带星的那一档就是改回自动。没有说明行，也没有另外的按钮。
 */
function RatingPicker({ rating, edit }: { rating: ImageRating; edit: (edits: ImageEdit[]) => void }) {
  const { t } = useTranslation(["inspector", "common"]);
  const { suggested, manual, effective } = rating;
  // 画师的分级和模型的不一样时，带星的那一档是“改回自动”。
  const overridden = manual !== null && suggested !== null && manual !== suggested;
  return (
    <Segmented<ContentRating>
      label={t("rating.label")}
      className="insp-rate"
      value={effective}
      onChange={(value) =>
        edit([overridden && value === suggested ? { kind: "revertRating" } : { kind: "setRating", rating: value }])
      }
      options={RATINGS.map((r) => {
        const name = t(`common:rating.${r}`);
        if (r !== suggested) return { value: r, label: name };
        return {
          value: r,
          label: name,
          icon: (
            <Sparkles
              size={12}
              aria-hidden="true"
              className={manual === null ? "insp-rate-star" : "insp-rate-star is-idle"}
            />
          ),
          tip: overridden ? t("rating.revert") : undefined,
          ariaLabel: overridden ? t("rating.revertOption", { rating: name }) : t("rating.autoOption", { rating: name }),
        };
      })}
    />
  );
}

/** 这张图没有完成自动标签（#475）：一行状态与重试，原因在悬停提示。紧跟在标签面板下面。 */
function TaggingUnfinished({ failure, edit }: { failure: TaggingFailure; edit: (edits: ImageEdit[]) => void }) {
  const { t } = useTranslation("inspector");
  return (
    <div className="insp-tagging">
      <Tip label={t(`tagging.${failure}`)}>
        <span>{t("tagging.unfinished")}</span>
      </Tip>
      <button type="button" className="k-btn is-ghost is-sm" onClick={() => edit([{ kind: "retryTagging" }])}>
        <span className="k-label">{t("tagging.retry")}</span>
      </button>
    </div>
  );
}

/** 只选中一张时：文件名、所在文件夹与备注。分级在标签面板的属性表里（见 SelectionPanel）。 */
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
        <Tip label={detail.originalName} align="start">
          <div className="insp-file-name">{detail.originalName}</div>
        </Tip>
        <div className="insp-file-meta k-parts">
          <span>
            {detail.width} × {detail.height}
          </span>
          <span>{t("file.collectedAt", { at: formatMoment(detail.collectedAt) })}</span>
        </div>
      </div>
      {detail.versions.previous && <p className="selection-version">{t("file.newVersion")}</p>}
      {detail.versions.newer.length > 0 && <p className="selection-version">{t("file.oldVersion")}</p>}
      {detail.taggingFailure && <TaggingUnfinished failure={detail.taggingFailure} edit={edit} />}
      {/* 不在任何文件夹里时整块不出现（左栏已有“未归类”），与没有标签的类别不占行同一条规则。 */}
      {detail.folders.length > 0 && (
        <section className="insp-sec selection-folders" aria-label={t("folders.label")}>
          <h4>
            <Folder size={13} aria-hidden="true" />
            {t("folders.title")}
          </h4>
          <ul className="insp-chips">
            {detail.folders.map((folder) => (
              <li key={folder.id} className="insp-chip">
                <Name className="k-label">{folder.name}</Name>
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* 备注（#98）：字段用改版样式；有未保存的改动才出现“保存”，有自己写的备注才能“用来源的”。 */}
      <section className="insp-sec k-note">
        <label className="selection-note">
          <span className="insp-h">
            <StickyNote size={13} aria-hidden="true" />
            {manual === null && sources.length > 0 ? t("note.fromSource") : t("note.title")}
          </span>
          <textarea
            className="k-textarea"
            aria-label={t("note.title")}
            placeholder={t("note.placeholder")}
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        {(draft !== saved || manual !== null) && (
          <div className="selection-actions k-note-acts">
            {draft !== saved && (
              <button
                type="button"
                className="k-btn is-sm is-quiet"
                aria-label={t("note.saveLabel")}
                onClick={() => edit([{ kind: "setNote", text: draft }])}
              >
                <span className="k-label">{t("note.save")}</span>
              </button>
            )}
            <Tip label={sources.length ? t("note.revertTitle") : t("note.revertEmptyTitle")}>
              <button
                type="button"
                className="k-btn is-sm is-ghost"
                aria-label={t("note.revertLabel")}
                disabled={manual === null}
                onClick={() => edit([{ kind: "revertNote" }])}
              >
                <span className="k-label">{t("note.revert")}</span>
              </button>
            </Tip>
          </div>
        )}
      </section>
      {detail.sourceLinks?.length > 0 && (
        <ul className="insp-links" aria-label={t("links")}>
          {detail.sourceLinks.map((url) => (
            <li key={url}>
              <Link2 size={13} aria-hidden="true" />
              {/^https?:\/\//i.test(url) ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
              ) : (
                <span>{url}</span>
              )}
            </li>
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
  onError: (message: string) => void;
}) {
  const [preview, setPreview] = useState<PermanentDeletePreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([libraryId, ids, safeMode, Boolean(emptyTrash)]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    currentKey.current = key;
    return () => {
      currentKey.current = "";
    };
  }, [key]);

  const load = () =>
    (emptyTrash ? previewEmptyTrash(libraryId) : previewPermanentDelete(libraryId, ids)).then(
      (value) => {
        if (currentKey.current === key) setPreview(value);
      },
      (e) => {
        if (currentKey.current !== key) return;
        onError(errorText(e));
        onCancel();
      },
    );

  // 换了范围先清掉旧的预览；在渲染中比较，这一帧就不显示上一批的数字。重读留在 effect 里。
  const [previewFor, setPreviewFor] = useState(key);
  if (previewFor !== key) {
    setPreviewFor(key);
    setPreview(null);
    setChanged(false);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 已含图库、所选与安全模式，内容变了才重读；load 每次渲染都是新函数
  useEffect(() => {
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
          onError(errorText(e));
        }
      },
    );
  };

  const { t } = useTranslation("wall", { keyPrefix: "purge" });
  const title = emptyTrash ? t("emptyTrash") : t("title");
  // 提醒对话框挂在 body 上：详情面板收起（inert）时也能看到并操作（#98）。
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="k-backdrop" />
        <AlertDialog.Popup className="k-dialog is-alert permanent-delete" aria-label={title}>
          <AlertDialog.Title className="k-dialog-title">{title}</AlertDialog.Title>
          {!preview ? (
            <p className="k-dialog-desc" role="status">
              {t("checking")}
            </p>
          ) : (
            <>
              {changed && (
                <p className="k-set-note" role="status">
                  {t("changed")}
                </p>
              )}
              <AlertDialog.Description className="k-dialog-desc">
                {emptyTrash
                  ? t("confirmEmptyTrash", { library: emptyTrash.libraryName, count: preview.imageIds.length })
                  : t("confirmCount", { count: preview.imageIds.length })}
              </AlertDialog.Description>
              {preview.groups.length > 0 && (
                <>
                  <p className="k-dialog-desc">{t("groupsIntro")}</p>
                  <ul className="permanent-delete-groups" aria-label={t("groupsLabel")}>
                    {preview.groups.map((g) => (
                      <li key={g.groupId}>{t("groupCount", { name: g.name, count: g.imageIds.length })}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <div className="k-dialog-foot">
            <span className="k-grow" />
            <AlertDialog.Close className="k-btn" disabled={busy}>
              <span className="k-label">{t("cancel")}</span>
            </AlertDialog.Close>
            <button
              type="button"
              className="k-btn is-danger"
              disabled={busy || !preview || preview.imageIds.length === 0}
              onClick={confirm}
            >
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
  useEffect(() => {
    currentKey.current = requestKey;
    return () => {
      currentKey.current = "";
    };
  }, [requestKey]);

  const detailKey = JSON.stringify([requestKey, reloadKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadKey): 重读信号，与下面的 generation 一样不在 effect 里读
  // biome-ignore lint/correctness/useExhaustiveDependencies(generation): 词表代次前进时重读详情
  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (!single) {
      setLoaded(null);
      return;
    }
    workspaceImage(libraryId, single).then(
      (d) => alive && setLoaded({ key: detailKey, detail: d }),
      (e) => {
        if (alive) {
          setLoaded(null);
          setFailed(true);
          onError(e);
        }
      },
    );
    return () => {
      alive = false;
    };
    // 词表代次随 imagesChanged 前进（例如这张图打标失败被记下，#475）：重读详情，但不算换了一张，不先变成不可操作。
  }, [libraryId, single, reloadKey, onError, detailKey, generation]);
  const detail = loaded?.detail ?? null;
  const stale = loaded?.key !== detailKey;

  const edit = (edits: ImageEdit[]) =>
    editImages(libraryId, ids, edits).then(
      (details) => {
        if (currentKey.current !== requestKey) return;
        if (single && details[0]) setLoaded({ key: detailKey, detail: details[0] });
        if (safeMode && details.some((d) => isAdult(d.rating.effective))) onClear();
      },
      (e) => {
        if (currentKey.current === requestKey) onError(e);
      },
    );

  return (
    <div className="selection" aria-label={t("selection.label")}>
      {/* 标签面板保持在原位置（编辑中的输入不因详情重读而重置）；详情面板用 CSS order 把文件名排在它前面。
          分级是标签面板里属性表的最后一行（#518）：控件按图片重挂，换一张图时指示块直接出现在新位置，不从上一张的档位滑过来。 */}
      {!failed && (
        <TagPanel
          libraryId={libraryId}
          ids={ids}
          safe={safeMode}
          generation={generation}
          onError={onError}
          rating={
            detail
              ? {
                  label: t("rating.title"),
                  control: (
                    <div className="insp-rate-slot" aria-busy={stale} inert={stale}>
                      <RatingPicker key={detail.id} rating={detail.rating} edit={(e) => void edit(e)} />
                    </div>
                  ),
                }
              : undefined
          }
        />
      )}
      {detail && <Detail key={detail.id} detail={detail} stale={stale} edit={(e) => void edit(e)} />}
    </div>
  );
}
