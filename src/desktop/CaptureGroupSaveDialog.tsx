import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert, Folder, Library } from "lucide-react";
import { useSaveDestination, folderChoices, destinationAvailable, destinationLabel } from "../library/SaveDestination";
import { Select } from "../ui/Select";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { captureUrl } from "../ipc";

/** 存参考组前待收藏的截图：每张选的图库（`"skip"` 不加入参考组）和文件夹。 */
export type CaptureSave<T> = { target: T; entries: CaptureEntry[]; choices: Record<string, string>; folders: Record<string, string | null> };

/**
 * 收藏截图并保存参考组（#66）：桌面上有截图钉图时，存参考组前逐张选收藏的图库和文件夹。
 * 每张截图一行：缩略图在左，图库与文件夹两个 Select 并排；已收藏的截图在名称后标“已收藏”；位置用不了时在行内写原因。
 */
export function CaptureGroupSaveDialog<T>({ value, onChange, libraries, saving, onClose, onConfirm }: {
  value: CaptureSave<T>; onChange: (value: CaptureSave<T>) => void; libraries: LibraryRegistration[];
  saving: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const saveContext = useSaveDestination();
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog k-save-dialog capture-group-save">
        <Dialog.Title className="k-dialog-title">收藏截图并保存参考组</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">逐张选图库收藏，再一起存进参考组。</Dialog.Description>
        <ul className="capture-save-list">
          {value.entries.map((entry, i) => {
            const library = value.choices[entry.id];
            const folder = value.folders[entry.id] ?? null;
            const chosen = !!library && library !== "skip";
            const destination = { libraryId: library, folderId: folder };
            const collected = [...new Set(entry.collected.map((c) => libraries.find((l) => l.library.id === c.libraryId)?.library.name ?? "未登记的图库"))];
            const lost = chosen && saveContext.ready && !destinationAvailable(destination, saveContext.providers);
            return (
              <li key={entry.id} className={`capture-save-row${library === "skip" ? " is-skipped" : ""}`}>
                <img className="capture-save-thumb" src={captureUrl(entry.id)} alt={`截图 ${i + 1}`} draggable={false} />
                <div className="capture-save-main">
                  <p className="capture-save-head">
                    <strong>截图 {i + 1}</strong><span>{entry.width} × {entry.height}</span>
                    {collected.length > 0 && <span className="k-pill" title={`已收藏到 ${collected.join("、")}`}>已收藏</span>}
                  </p>
                  <div className="capture-save-fields">
                    <Select label={`截图 ${i + 1} 的图库`} icon={<Library size={16} aria-hidden="true" />} disabled={saving} value={library}
                      onChange={(next) => onChange({ ...value, choices: { ...value.choices, [entry.id]: next }, folders: { ...value.folders, [entry.id]: null } })}
                      options={[
                        { value: "", label: "选择图库…" },
                        ...libraries.map((option) => ({
                          value: option.library.id, disabled: !!option.unavailable,
                          label: `${option.library.name}${option.unavailable ? "（未连接）" : ""}`,
                        })),
                        { value: "skip", label: "不加入参考组" },
                      ]} />
                    <Select label={`截图 ${i + 1} 的文件夹`} icon={<Folder size={16} aria-hidden="true" />} disabled={saving || !chosen} value={chosen ? folder ?? "" : ""}
                      title={chosen ? `存到：${destinationLabel(destination, saveContext.providers)}` : undefined}
                      onChange={(next) => onChange({ ...value, folders: { ...value.folders, [entry.id]: next || null } })}
                      options={[
                        { value: "", label: chosen ? "未归类" : "文件夹" },
                        ...(chosen ? folderChoices(saveContext.providers.find((p) => p.registration.library.id === library)?.sidebar?.folders ?? [])
                          .map((f) => ({ value: f.id, label: f.path })) : []),
                      ]} />
                  </div>
                  {lost && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />这个位置现在用不了，换一个图库或文件夹</p>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="k-dialog-foot">
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={saving} onClick={onClose}>取消</button>
          <button type="button" className="k-btn is-primary"
            disabled={saving || !saveContext.ready || value.entries.some((e) => value.choices[e.id] !== "skip" && !destinationAvailable({ libraryId: value.choices[e.id], folderId: value.folders[e.id] ?? null }, saveContext.providers))}
            onClick={onConfirm}>{saving ? "正在收藏并保存…" : "确认并保存"}</button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
