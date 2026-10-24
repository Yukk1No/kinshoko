import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert, Folder, Library } from "lucide-react";
import { useSaveDestination, folderChoices, destinationAvailable, destinationLabel } from "../library/SaveDestination";
import { Select } from "../ui/Select";
import type { CaptureChoice } from "../bindings/CaptureChoice";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { captureUrl } from "../ipc";

/** 截图只存在参考组里（#270）。 */
export const KEEP_IN_GROUP = "group";
/** 截图不加入参考组。 */
export const SKIP = "skip";

/**
 * 存参考组前桌面上的截图：每张选的去处（图库 id、{@link KEEP_IN_GROUP} 或 {@link SKIP}，空为还没选）
 * 和收藏进图库时的文件夹。
 */
export type CaptureSave<T> = { target: T; entries: CaptureEntry[]; choices: Record<string, string>; folders: Record<string, string | null> };

/** 对话框里的选择交给保存入口。 */
export function captureChoices<T>(value: CaptureSave<T>): CaptureChoice[] {
  return value.entries.map((entry) => {
    const choice = value.choices[entry.id];
    if (choice === KEEP_IN_GROUP) return { captureId: entry.id, libraryId: null, folderId: null, keepInGroup: true };
    if (choice === SKIP) return { captureId: entry.id, libraryId: null, folderId: null };
    return { captureId: entry.id, libraryId: choice, folderId: value.folders[entry.id] ?? null };
  });
}

/**
 * 截图怎样存进参考组（#66、#270）：桌面上有截图钉图时，存参考组前逐张选去处——收藏进某个图库
 * （再选文件夹）、只存在参考组里（不进图库），或不加入参考组。
 * 每张截图一行：缩略图在左，去处与文件夹两个 Select 并排；位置用不了时在行内写原因。
 */
export function CaptureGroupSaveDialog<T>({ value, onChange, libraries, saving, onClose, onConfirm }: {
  value: CaptureSave<T>; onChange: (value: CaptureSave<T>) => void; libraries: LibraryRegistration[];
  saving: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const saveContext = useSaveDestination();
  const collecting = (choice: string | undefined) => !!choice && choice !== SKIP && choice !== KEEP_IN_GROUP;
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog k-save-dialog capture-group-save">
        <Dialog.Title className="k-dialog-title">截图怎样存进参考组</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">逐张选择：收藏进图库，只存在参考组里，或不加入参考组。只存在参考组里的截图不进图库，参考组不再用它时一起删除。</Dialog.Description>
        <ul className="capture-save-list">
          {value.entries.map((entry, i) => {
            const choice = value.choices[entry.id];
            const folder = value.folders[entry.id] ?? null;
            const chosen = collecting(choice);
            const destination = { libraryId: choice, folderId: folder };
            const lost = chosen && saveContext.ready && !destinationAvailable(destination, saveContext.providers);
            return (
              <li key={entry.id} className={`capture-save-row${choice === SKIP ? " is-skipped" : ""}`}>
                <img className="capture-save-thumb" src={captureUrl(entry.id)} alt={`截图 ${i + 1}`} draggable={false} />
                <div className="capture-save-main">
                  <p className="capture-save-head"><strong>截图 {i + 1}</strong><span>{entry.width} × {entry.height}</span></p>
                  <div className="capture-save-fields">
                    <Select label={`截图 ${i + 1} 存到哪里`} icon={<Library size={16} aria-hidden="true" />} disabled={saving} value={choice}
                      onChange={(next) => onChange({ ...value, choices: { ...value.choices, [entry.id]: next }, folders: { ...value.folders, [entry.id]: null } })}
                      options={[
                        { value: "", label: "选择去处…" },
                        ...libraries.map((option) => ({
                          value: option.library.id, disabled: !!option.unavailable,
                          label: `收藏到${option.library.name}${option.unavailable ? "（未连接）" : entry.collected.some((c) => c.libraryId === option.library.id) ? "（已收藏）" : ""}`,
                        })),
                        { value: KEEP_IN_GROUP, label: "只存在参考组里" },
                        { value: SKIP, label: "不加入参考组" },
                      ]} />
                    <Select label={`截图 ${i + 1} 的文件夹`} icon={<Folder size={16} aria-hidden="true" />} disabled={saving || !chosen} value={chosen ? folder ?? "" : ""}
                      title={chosen ? `存到：${destinationLabel(destination, saveContext.providers)}` : undefined}
                      onChange={(next) => onChange({ ...value, folders: { ...value.folders, [entry.id]: next || null } })}
                      options={[
                        { value: "", label: chosen ? "未归类" : "文件夹" },
                        ...(chosen ? folderChoices(saveContext.providers.find((p) => p.registration.library.id === choice)?.sidebar?.folders ?? [])
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
          <button type="button" className="k-btn" disabled={saving} onClick={onClose}><span className="k-label">取消</span></button>
          <button type="button" className="k-btn is-primary"
            disabled={saving || !saveContext.ready || value.entries.some((e) => {
              const choice = value.choices[e.id];
              return choice !== SKIP && choice !== KEEP_IN_GROUP && !destinationAvailable({ libraryId: choice, folderId: value.folders[e.id] ?? null }, saveContext.providers);
            })}
            onClick={onConfirm}><span className="k-label">{saving ? "正在保存…" : "确认并保存"}</span></button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
