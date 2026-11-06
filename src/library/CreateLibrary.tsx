import { useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, FolderOpen, Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";
import { createLibrary, createLibraryUnopened, errorText, pickFolder } from "../ipc";
import { useSaveDestination } from "./SaveDestination";

/** 新建图库要填的两项：名称与存放位置（新文件夹的上级）。 */
export type NewLibraryDraft = { name: string; parent: string | null };
/** 建好的图库。 */
export type CreatedLibrary = { id: string; name: string; root: string };

/** 新文件夹的完整路径，只用来给画师看；真正的路径由后端拼。 */
function preview(parent: string, name: string) {
  return /[\\/]$/.test(parent) ? `${parent}${name}` : `${parent}\\${name}`;
}

/**
 * 新建图库的名称与存放位置两栏（受控）。`compact` 用在订阅榜单「新建图库」卡片里：不带栏名，位置一行更矮。
 * 新文件夹在所选位置下、与图库同名；位置一栏预览完整路径。
 */
export function NewLibraryFields({ value, onChange, disabled, compact = false }: {
  value: NewLibraryDraft; onChange: (patch: Partial<NewLibraryDraft>) => void;
  disabled?: boolean; compact?: boolean;
}) {
  const { t } = useTranslation("library", { keyPrefix: "create" });
  const ids = useId();
  const choose = async () => {
    const picked = await pickFolder();
    if (picked) onChange({ parent: picked });
  };
  const path = value.parent ? preview(value.parent, value.name.trim() || "…") : t("notChosen");
  const chooseLabel = compact && value.parent ? t("change") : t("choose");
  if (compact) return <div className="create-library-compact">
    <span className="k-input"><input aria-label={t("name")} value={value.name} disabled={disabled} onChange={(e) => onChange({ name: e.target.value })} /></span>
    <div className={`create-library-path is-compact${value.parent ? " is-set" : ""}`}>
      <FolderOpen size={14} aria-hidden="true" />
      <span className="create-library-path-text" title={value.parent ?? undefined}>{path}</span>
      <button type="button" className="k-btn is-sm" disabled={disabled} onClick={() => void choose()}><span className="k-label">{chooseLabel}</span></button>
    </div>
  </div>;
  return <>
    <label className="k-field">
      <span className="k-field-label">{t("name")}</span>
      <input className="k-input" value={value.name} disabled={disabled} onChange={(e) => onChange({ name: e.target.value })} />
    </label>
    <div className="k-field" role="group" aria-labelledby={`${ids}-loc`}>
      <span className="k-field-label" id={`${ids}-loc`}>{t("location")}</span>
      <div className={`create-library-path${value.parent ? " is-set" : ""}`}>
        <FolderOpen size={16} aria-hidden="true" />
        <span className="create-library-path-text" title={value.parent ?? undefined}>{path}</span>
        <button type="button" className="k-btn is-sm" disabled={disabled} onClick={() => void choose()}><span className="k-label">{chooseLabel}</span></button>
      </div>
    </div>
  </>;
}

/**
 * 新建图库的表单：两栏、报错与建立按钮。在所选位置新建同名文件夹并登记到本设备，记住这次的位置（ADR-0016）。
 * `opens` 时建好后打开它（主窗口新建）；否则只登记不切换（订阅里就地新建）。有 `onCancel` 时脚部是对话框的「取消／建立」。
 */
function NewLibraryForm({ opens, onCreated, onBusyChange, onCancel }: {
  opens: boolean;
  onCreated: (library: CreatedLibrary) => void;
  onBusyChange?: (busy: boolean) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation("library", { keyPrefix: "create" });
  const { rememberNewLibraryParent } = useSaveDestination();
  const [draft, setDraft] = useState<NewLibraryDraft>(() => ({ name: t("defaultName"), parent: null }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !!draft.parent && !!draft.name.trim() && !busy;

  const create = async () => {
    if (!draft.parent) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const created = await (opens ? createLibrary : createLibraryUnopened)(draft.parent, draft.name.trim());
      rememberNewLibraryParent(draft.parent);
      onCreated(created);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const submit = <button type="button" className={`k-btn is-primary${onCancel ? "" : " is-lg"}`} disabled={!ready} onClick={() => void create()}>
    <span className="k-label">{t("submit")}</span>
  </button>;
  return <>
    <NewLibraryFields value={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} disabled={busy} />
    {error && <p className="create-library-error" role="alert">{error}</p>}
    {onCancel
      ? <div className="k-dialog-foot">
        <span className="k-grow" />
        <button type="button" className="k-btn" disabled={busy} onClick={onCancel}><span className="k-label">{t("cancel")}</span></button>
        {submit}
      </div>
      : <div className="create-library-foot">{submit}</div>}
  </>;
}

/**
 * 首次使用的建库引导：居中引导（#172 原型 A）的第二步，建好后打开新图库；`onBack` 回到欢迎页。
 */
export function CreateLibrary({ onCreated, onBusyChange, onBack, backLabel }: {
  onCreated: (library: CreatedLibrary) => void;
  onBusyChange?: (busy: boolean) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const { t } = useTranslation("library");
  const [busy, setBusy] = useState(false);
  const ids = useId();
  return <div className="welcome">
    <section className="create-library" aria-labelledby={`${ids}-title`}>
      <button type="button" className="welcome-back" disabled={busy} onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /><span className="k-label">{backLabel}</span></button>
      <div>
        <h1 id={`${ids}-title`}>{t("create.title")}</h1>
        <p className="create-library-desc">{t("create.lead")}</p>
      </div>
      <NewLibraryForm opens onCreated={onCreated} onBusyChange={(b) => { setBusy(b); onBusyChange?.(b); }} />
    </section>
    <p className="welcome-tip"><Lightbulb size={14} aria-hidden="true" />{t("welcome.eagleTip")}</p>
  </div>;
}

/**
 * 新建图库对话框：已有图库时从图库切换器打开（`opens`，建好后打开它），或叠在订阅对话框上就地新建（只登记不切换）。
 * 建立中不能关掉。放在别的对话框里面渲染时成为它的子对话框，Esc 与点背景只关掉这一层。
 */
export function CreateLibraryDialog({ opens = false, onClose, onCreated, onBusyChange }: {
  opens?: boolean;
  onClose: () => void;
  onCreated: (library: CreatedLibrary) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation("library", { keyPrefix: "create" });
  const [busy, setBusy] = useState(false);
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog create-library-dialog">
        <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
        <NewLibraryForm opens={opens} onCreated={onCreated} onCancel={onClose}
          onBusyChange={(b) => { setBusy(b); onBusyChange?.(b); }} />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
