import { useEffect, useId, useState } from "react";
import { DialogShell } from "../ui/DialogShell";
import { ChevronLeft, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { createLibrary, createLibraryUnopened, errorText, pickFolder, picturesFolder } from "../ipc";
import { useSaveDestination } from "./SaveDestination";
import { createLibraryParentPrefill } from "./savePrefill";
import { Tip } from "../ui/Tip";

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
export function NewLibraryFields({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  value: NewLibraryDraft;
  onChange: (patch: Partial<NewLibraryDraft>) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation("library", { keyPrefix: "create" });
  const ids = useId();
  const choose = async () => {
    const picked = await pickFolder();
    if (picked) onChange({ parent: picked });
  };
  const path = value.parent ? preview(value.parent, value.name.trim() || "…") : t("notChosen");
  const chooseLabel = compact && value.parent ? t("change") : t("choose");
  if (compact)
    return (
      <div className="create-library-compact">
        <span className="k-input">
          <input
            aria-label={t("name")}
            value={value.name}
            disabled={disabled}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </span>
        <div className={`create-library-path is-compact${value.parent ? " is-set" : ""}`}>
          <FolderOpen size={14} aria-hidden="true" />
          <Tip label={value.parent} align="start">
            <span className="create-library-path-text">{path}</span>
          </Tip>
          <button type="button" className="k-btn is-sm" disabled={disabled} onClick={() => void choose()}>
            <span className="k-label">{chooseLabel}</span>
          </button>
        </div>
      </div>
    );
  return (
    <>
      <label className="k-field">
        <span className="k-section-label">{t("name")}</span>
        <input
          className="k-input"
          value={value.name}
          disabled={disabled}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      <div className="k-field" role="group" aria-labelledby={`${ids}-loc`}>
        <span className="k-section-label" id={`${ids}-loc`}>
          {t("location")}
        </span>
        <div className={`create-library-path${value.parent ? " is-set" : ""}`}>
          <FolderOpen size={16} aria-hidden="true" />
          <Tip label={value.parent} align="start">
            <span className="create-library-path-text">{path}</span>
          </Tip>
          <button type="button" className="k-btn is-sm" disabled={disabled} onClick={() => void choose()}>
            <span className="k-label">{chooseLabel}</span>
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 新建图库表单的状态与建立动作：位置按 ADR-0016 预填（和已有的图库放在一起 → 系统的「图片」文件夹）；
 * 只记画师亲手选的位置，预填的不写进记忆，免得盖掉暂时读不到的那条。
 * `opens` 时建好后打开它（主窗口新建）；否则只登记不切换（订阅里就地新建）。
 */
function useNewLibraryForm({
  opens,
  onCreated,
  onBusyChange,
}: {
  opens: boolean;
  onCreated: (library: CreatedLibrary) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation("library", { keyPrefix: "create" });
  const { providers, memory, rememberNewLibraryParent } = useSaveDestination();
  const [name, setName] = useState(() => t("defaultName"));
  const [chosen, setChosen] = useState<string | null>(null);
  const [pictures, setPictures] = useState<string | null>(null);
  const draft: NewLibraryDraft = {
    name,
    parent: chosen ?? createLibraryParentPrefill(memory.newLibraryParent, providers, pictures),
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !!draft.parent && !!draft.name.trim() && !busy;

  useEffect(() => {
    let live = true;
    picturesFolder().then(
      (dir) => {
        if (live) setPictures(dir);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const changeDraft = (patch: Partial<NewLibraryDraft>) => {
    if (patch.name !== undefined) setName(patch.name);
    if (patch.parent) setChosen(patch.parent);
  };

  const create = async () => {
    if (!draft.parent) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const created = await (opens ? createLibrary : createLibraryUnopened)(draft.parent, draft.name.trim());
      if (chosen) rememberNewLibraryParent(chosen);
      onCreated(created);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return { draft, busy, ready, error, changeDraft, create };
}

/**
 * 新建图库的表单：两栏、报错与建立按钮。在所选位置新建同名文件夹并登记到本设备。
 * 整页引导的脚部是 `.create-library-foot`。
 */
function NewLibraryForm({
  opens,
  onCreated,
  onBusyChange,
}: {
  opens: boolean;
  onCreated: (library: CreatedLibrary) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation("library", { keyPrefix: "create" });
  const form = useNewLibraryForm({ opens, onCreated, onBusyChange });
  return (
    <>
      <NewLibraryFields value={form.draft} disabled={form.busy} onChange={form.changeDraft} />
      {form.error && (
        <p className="k-error-text" role="alert">
          {form.error}
        </p>
      )}
      <div className="create-library-foot">
        <button
          type="button"
          className="k-btn is-primary is-lg"
          disabled={!form.ready}
          onClick={() => void form.create()}
        >
          <span className="k-label">{t("submit")}</span>
        </button>
      </div>
    </>
  );
}

/**
 * 首次使用的建库引导：居中引导（#172 原型 A）的第二步，建好后打开新图库；`onBack` 回到欢迎页。
 */
export function CreateLibrary({
  onCreated,
  onBusyChange,
  onBack,
  backLabel,
}: {
  onCreated: (library: CreatedLibrary) => void;
  onBusyChange?: (busy: boolean) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const { t } = useTranslation("library");
  const [busy, setBusy] = useState(false);
  const ids = useId();
  return (
    <div className="welcome">
      <section className="create-library" aria-labelledby={`${ids}-title`}>
        <button type="button" className="welcome-back" disabled={busy} onClick={onBack}>
          <ChevronLeft size={14} aria-hidden="true" />
          <span className="k-label">{backLabel}</span>
        </button>
        <h1 id={`${ids}-title`} className="k-title">
          {t("create.title")}
        </h1>
        <NewLibraryForm
          opens
          onCreated={onCreated}
          onBusyChange={(b) => {
            setBusy(b);
            onBusyChange?.(b);
          }}
        />
      </section>
    </div>
  );
}

/**
 * 新建图库对话框：已有图库时从图库切换器打开（`opens`，建好后打开它），或叠在订阅对话框上就地新建（只登记不切换）。
 * 建立中不能关掉。放在别的对话框里面渲染时成为它的子对话框，Esc 与点背景只关掉这一层。
 */
export function CreateLibraryDialog({
  opens = false,
  onClose,
  onCreated,
  onBusyChange,
}: {
  opens?: boolean;
  onClose: () => void;
  onCreated: (library: CreatedLibrary) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation("library", { keyPrefix: "create" });
  const form = useNewLibraryForm({ opens, onCreated, onBusyChange });
  return (
    <DialogShell
      open
      purpose="form"
      busy={form.busy}
      title={t("title")}
      onOpenChange={(open) => {
        if (!open && !form.busy) onClose();
      }}
      className="create-library-dialog"
      footer={
        <>
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={form.busy} onClick={onClose}>
            <span className="k-label">{t("cancel")}</span>
          </button>
          <button type="button" className="k-btn is-primary" disabled={!form.ready} onClick={() => void form.create()}>
            <span className="k-label">{t("submit")}</span>
          </button>
        </>
      }
    >
      <NewLibraryFields value={form.draft} disabled={form.busy} onChange={form.changeDraft} />
      {form.error && (
        <p className="k-error-text" role="alert">
          {form.error}
        </p>
      )}
    </DialogShell>
  );
}
