import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { LibraryDeletePreview } from "../bindings/LibraryDeletePreview";
import type { LibraryTarget } from "../bindings/LibraryTarget";
import { describeCommandError, errorText, isDeletePreviewStale, permanentDeleteBatch, previewPermanentDeleteBatch } from "../ipc";

/** 按图库报告没完成的部分：“「图库」：原因；「图库」：原因”。原因是后端的错误代码或抛出的错误。 */
export function libraryFailures(failures: { libraryId: string; error: unknown }[], libraryName: (id: string) => string): string {
  return failures.map((failure) => `「${libraryName(failure.libraryId)}」：${errorText(failure.error)}`).join("；");
}

/**
 * 跨图库的多张永久删除（ADR-0008，#112）：后端按图库分组，逐组切换可写句柄预览与删除。
 * 断连等核对不了的图库就地说明、不删；确认后其他图库照常删除，没删完的按图库报告。
 * 某组的预览在确认前过期时只重新预览那些图库，让画师看过新的影响再确认。
 */
export function PermanentDeleteBatchConfirm({ targets, libraryName, onDone, onCancel, onError }: {
  targets: LibraryTarget[];
  libraryName: (libraryId: string) => string;
  onDone: () => void;
  onCancel: () => void;
  onError: (error: unknown) => void;
}) {
  const [pending, setPending] = useState(targets);
  const [previews, setPreviews] = useState<LibraryDeletePreview[] | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** 已有图库删完（例如其他图库预览过期、正在重新列出）：之后取消也要让界面刷新、取消选择。 */
  const deletedSome = useRef(false);
  const cancel = () => (deletedSome.current ? onDone() : onCancel());

  useEffect(() => {
    let current = true;
    setPreviews(null);
    previewPermanentDeleteBatch(pending).then((value) => { if (current) setPreviews(value); }, (e) => {
      if (!current) return;
      onError(e);
      cancel();
    });
    return () => { current = false; };
  }, [pending]);

  const ready = previews?.filter((p) => p.preview) ?? [];
  const unavailable = previews?.filter((p) => p.error !== null) ?? [];
  const total = ready.reduce((sum, p) => sum + p.preview!.imageIds.length, 0);
  // 同一个参考组可能同时用到几个图库里的图：合成一行。
  const groups = ready.flatMap((p) => p.preview!.groups).reduce<{ groupId: string; name: string; count: number }[]>((all, group) => {
    const found = all.find((g) => g.groupId === group.groupId);
    if (found) found.count += group.imageIds.length;
    else all.push({ groupId: group.groupId, name: group.name, count: group.imageIds.length });
    return all;
  }, []);
  const count = (libraryId: string) => pending.filter((target) => target.libraryId === libraryId).length;

  const confirm = () => {
    if (!previews || total === 0) return;
    setBusy(true);
    permanentDeleteBatch(ready.map((p) => ({ libraryId: p.libraryId, imageIds: p.preview!.imageIds, token: p.preview!.token }))).then(
      (failed) => {
        if (!alive.current) return;
        setBusy(false);
        if (ready.some((p) => !failed.some((f) => f.libraryId === p.libraryId))) deletedSome.current = true;
        const stale = new Set(failed.filter((f) => isDeletePreviewStale(f.error)).map((f) => f.libraryId));
        const reported = previews.flatMap((p) => {
          if (p.error !== null) return [{ libraryId: p.libraryId, error: p.error }];
          const failure = failed.find((f) => f.libraryId === p.libraryId && !stale.has(f.libraryId));
          return failure ? [failure] : [];
        });
        if (reported.length) onError(`有图库没有删完。${libraryFailures(reported, libraryName)}`);
        if (stale.size) {
          setChanged(true);
          setPending(pending.filter((target) => stale.has(target.libraryId)));
          return;
        }
        onDone();
      },
      (e) => {
        if (!alive.current) return;
        setBusy(false);
        onError(e);
      },
    );
  };

  return (
    <AlertDialog.Root open onOpenChange={(open) => { if (!open && !busy) cancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="k-backdrop" />
        <AlertDialog.Popup className="k-dialog is-alert permanent-delete" aria-label="永久删除">
          <AlertDialog.Title className="k-dialog-title">永久删除</AlertDialog.Title>
          {!previews ? <p className="k-dialog-desc" role="status">正在核对参考组…</p> : <>
            {changed && <p className="k-set-note" role="status">回收站或参考组刚有变化，已按最新情况重新列出。</p>}
            <AlertDialog.Description className="k-dialog-desc">
              {total > 0 ? `永久删除这 ${total} 张图？原图与整理结果都会删除，无法恢复。` : "这些图这次都删不了。"}
            </AlertDialog.Description>
            {unavailable.map((p) => (
              <p key={p.libraryId} className="k-set-note" role="status">「{libraryName(p.libraryId)}」的 {count(p.libraryId)} 张这次删不了：{p.error && describeCommandError(p.error)}</p>
            ))}
            {groups.length > 0 && (
              <>
                <p className="k-dialog-desc">这些参考组用到了它们，成员位置会保留并标为缺失：</p>
                <ul className="permanent-delete-groups" aria-label="受影响的参考组">
                  {groups.map((g) => (
                    <li key={g.groupId}>
                      {g.name}（{g.count} 张）
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>}
          <div className="k-dialog-foot">
            <span className="k-grow" />
            <AlertDialog.Close className="k-btn" disabled={busy}><span className="k-label">取消</span></AlertDialog.Close>
            <button type="button" className="k-btn is-danger" disabled={busy || !previews || total === 0} onClick={confirm}>
              <span className="k-label">确认永久删除</span>
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
