import { useId, useState } from "react";
import { ChevronLeft, FolderOpen, Lightbulb } from "lucide-react";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import { createLibrary, pickFolder } from "../ipc";

/** 新文件夹的完整路径，只用来给画师看；真正的路径由后端拼。 */
function preview(parent: string, name: string) {
  return /[\\/]$/.test(parent) ? `${parent}${name}` : `${parent}\\${name}`;
}

/**
 * 建立资料库：起名、选择存放位置，在那里新建同名文件夹，登记到本设备并打开。
 * 居中引导（#172 原型 A）的第二步；`onBack` 回到上一屏（欢迎页或正在看的图库）。
 */
export function CreateLibrary({ onCreated, onBusyChange, onBack, backLabel }: {
  onCreated: (library: LibraryInfo) => void;
  onBusyChange?: (busy: boolean) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const [name, setName] = useState("我的参考");
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();

  const choose = async () => {
    const picked = await pickFolder();
    if (picked) setParent(picked);
  };

  const create = async () => {
    if (!parent) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      onCreated(await createLibrary(parent, name.trim()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return <div className="welcome">
    <section className="create-library" aria-labelledby={`${ids}-title`}>
      <button type="button" className="welcome-back" disabled={busy} onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /><span className="k-label">{backLabel}</span></button>
      <div>
        <h1 id={`${ids}-title`}>新建图库</h1>
        <p className="create-library-desc">图片会存进这个新文件夹</p>
      </div>
      <label className="k-field">
        <span className="k-field-label">图库名称</span>
        <input className="k-input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="k-field" role="group" aria-labelledby={`${ids}-loc`}>
        <span className="k-field-label" id={`${ids}-loc`}>存放位置</span>
        <div className={`create-library-path${parent ? " is-set" : ""}`}>
          <FolderOpen size={16} aria-hidden="true" />
          <span className="create-library-path-text" title={parent ?? undefined}>{parent ? preview(parent, name.trim() || "…") : "尚未选择"}</span>
          <button type="button" className="k-btn is-sm" disabled={busy} onClick={choose}><span className="k-label">选择存放位置…</span></button>
        </div>
      </div>
      {error && <p className="create-library-error" role="alert">{error}</p>}
      <div className="create-library-foot">
        <button type="button" className="k-btn is-primary is-lg" disabled={!parent || !name.trim() || busy} onClick={create}>
          <span className="k-label">建立图库</span>
        </button>
      </div>
    </section>
    <p className="welcome-tip"><Lightbulb size={14} aria-hidden="true" />用过 Eagle？建好图库后从“导入”迁入</p>
  </div>;
}
