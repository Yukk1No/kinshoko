import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert, Folder, Library } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSaveDestination, folderChoices, destinationLabel } from "../library/SaveDestination";
import { Select } from "../ui/Select";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { captureUrl } from "../ipc";
import { chooseDestination, destinationOf, prepareSave, type CaptureDestination, type CaptureSaveDraft, type CaptureSavePlan } from "./captureSavePlan";

/** 去处选择里“只存在参考组里”（#270）和“不加入参考组”的值；其余非空值是图库 id。 */
const KEEP_IN_GROUP = "group";
const SKIP = "skip";

function choiceValue(destination: CaptureDestination): string {
  switch (destination.kind) {
    case "unselected": return "";
    case "skip": return SKIP;
    case "keepInGroup": return KEEP_IN_GROUP;
    case "collect": return destination.destination.libraryId;
  }
}

function parseChoice(value: string): CaptureDestination {
  if (!value) return { kind: "unselected" };
  if (value === SKIP) return { kind: "skip" };
  if (value === KEEP_IN_GROUP) return { kind: "keepInGroup" };
  return { kind: "collect", destination: { libraryId: value, folderId: null } };
}

/**
 * 截图怎样存进参考组（#66、#270）：桌面上有截图钉图时，存参考组前逐张选去处——收藏进某个图库
 * （再选文件夹）、只存在参考组里（不进图库），或不加入参考组。
 * 每张截图一行：缩略图在左，去处与文件夹两个 Select 并排；已收藏的截图在名称后标“已收藏”；位置用不了时在行内写原因。
 */
export function CaptureGroupSaveDialog<T>({ value, onChange, libraries, saving, onClose, onConfirm }: {
  value: CaptureSaveDraft<T>; onChange: (value: CaptureSaveDraft<T>) => void; libraries: LibraryRegistration[];
  saving: boolean; onClose: () => void; onConfirm: (plan: CaptureSavePlan<T>) => void;
}) {
  const { t } = useTranslation("desktop", { keyPrefix: "captureSave" });
  const saveContext = useSaveDestination();
  const prepared = prepareSave(value, saveContext.providers);
  const problems = prepared.ok ? [] : prepared.problems;
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog k-save-dialog capture-group-save">
        <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">{t("description")}</Dialog.Description>
        <ul className="capture-save-list">
          {value.entries.map((entry, i) => {
            const current = destinationOf(value, entry.id);
            const destination = current.kind === "collect" ? current.destination : null;
            const chosen = !!destination;
            const folder = destination?.folderId ?? null;
            const collected = [...new Set(entry.collected.map((c) => libraries.find((l) => l.library.id === c.libraryId)?.library.name ?? t("unregisteredLibrary")))];
            const lost = saveContext.ready && problems.some((p) => p.captureId === entry.id && p.reason === "unavailable");
            return (
              <li key={entry.id} className={`capture-save-row${current.kind === "skip" ? " is-skipped" : ""}`}>
                <img className="capture-save-thumb" src={captureUrl(entry.id)} alt={t("thumbAlt", { n: i + 1 })} draggable={false} />
                <div className="capture-save-main">
                  <p className="capture-save-head">
                    <strong>{t("name", { n: i + 1 })}</strong><span>{entry.width} × {entry.height}</span>
                    {collected.length > 0 && <span className="k-pill" title={t("collectedTo", { libraries: collected.join(t("librarySeparator")) })}><span className="k-label">{t("collected")}</span></span>}
                  </p>
                  <div className="capture-save-fields">
                    <Select label={t("destinationLabel", { n: i + 1 })} icon={<Library size={16} aria-hidden="true" />} disabled={saving} value={choiceValue(current)}
                      onChange={(next) => onChange(chooseDestination(value, entry.id, parseChoice(next)))}
                      options={[
                        { value: "", label: t("choose") },
                        ...libraries.map((option) => ({
                          value: option.library.id, disabled: !!option.unavailable,
                          label: t(option.unavailable ? "collectToOffline" : "collectTo", { name: option.library.name }),
                        })),
                        { value: KEEP_IN_GROUP, label: t("keepInGroup") },
                        { value: SKIP, label: t("skip") },
                      ]} />
                    <Select label={t("folderLabel", { n: i + 1 })} icon={<Folder size={16} aria-hidden="true" />} disabled={saving || !chosen} value={chosen ? folder ?? "" : ""}
                      title={chosen ? t("savesTo", { place: destinationLabel(destination, saveContext.providers) }) : undefined}
                      onChange={(next) => { if (destination) onChange(chooseDestination(value, entry.id, { kind: "collect", destination: { libraryId: destination.libraryId, folderId: next || null } })); }}
                      options={[
                        { value: "", label: chosen ? t("unassigned") : t("folder") },
                        ...(destination ? folderChoices(saveContext.providers.find((p) => p.registration.library.id === destination.libraryId)?.sidebar?.folders ?? [])
                          .map((f) => ({ value: f.id, label: f.path })) : []),
                      ]} />
                  </div>
                  {lost && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{t("unavailable")}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="k-dialog-foot">
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={saving} onClick={onClose}><span className="k-label">{t("cancel")}</span></button>
          <button type="button" className="k-btn is-primary"
            disabled={saving || !saveContext.ready || !prepared.ok}
            onClick={() => { if (prepared.ok) onConfirm(prepared.plan); }}><span className="k-label">{saving ? t("saving") : t("confirm")}</span></button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
