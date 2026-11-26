import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog } from "../ui/DialogShell";
import type { PermanentDeletePreview } from "../bindings/PermanentDeletePreview";
import { isDeletePreviewStale, permanentDelete, previewEmptyTrash, previewPermanentDelete } from "../ipc";
import { errorText } from "../ipc/commandError";

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
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      title={title}
      description={
        preview
          ? emptyTrash
            ? t("confirmEmptyTrash", { library: emptyTrash.libraryName, count: preview.imageIds.length })
            : t("confirmCount", { count: preview.imageIds.length })
          : undefined
      }
      className="permanent-delete"
      cancelRef={cancel}
      footer={
        <>
          <span className="k-grow" />
          <button ref={cancel} type="button" className="k-btn" disabled={busy} onClick={onCancel}>
            <span className="k-label">{t("cancel")}</span>
          </button>
          <button
            type="button"
            className="k-btn is-danger"
            disabled={busy || !preview || preview.imageIds.length === 0}
            onClick={confirm}
          >
            <span className="k-label">{emptyTrash ? t("emptyTrash") : t("confirm")}</span>
          </button>
        </>
      }
    >
      {!preview ? (
        <p className="k-dialog-desc" role="status">
          {t("checking")}
        </p>
      ) : (
        <>
          {changed && (
            <p className="k-description is-spaced" role="status">
              {t("changed")}
            </p>
          )}
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
    </AlertDialog>
  );
}
