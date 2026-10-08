import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SaveDestination } from "../bindings/SaveDestination";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import type { FolderNode } from "../bindings/FolderNode";
import { onWorkspaceChanged, workspaceDirectories } from "../ipc";
import { libraryPathHint } from "./library-path";

type SaveContext = {
  destination: SaveDestination | null;
  setDestination: (value: SaveDestination | null) => void;
  providers: WorkspaceDirectory[];
  problem: string | null;
  ready: boolean;
};
const Context = createContext<SaveContext>({
  destination: null, setDestination: () => {}, providers: [], problem: null, ready: false,
});
export const useSaveDestination = () => useContext(Context);

export function SaveDestinationProvider({ safe, children }: { safe: boolean; children: ReactNode }) {
  const [destination, setDestination] = useState<SaveDestination | null>(null);
  const [providers, setProviders] = useState<WorkspaceDirectory[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true, sequence = 0, revision = "";
    setReady(false);
    const refresh = () => {
      const request = ++sequence;
      void workspaceDirectories(safe).then(value => {
        if (!alive || request !== sequence) return;
        revision = value.status.revision;
        setProviders(value.providers); setProblem(null); setReady(true);
      }, error => {
        if (alive && request === sequence) { setProblem(String(error)); setReady(false); }
      });
    };
    refresh();
    const stop = onWorkspaceChanged(value => { if (value.revision !== revision) refresh(); });
    return () => { alive = false; void stop.then(fn => fn()); };
  }, [safe]);
  return <Context.Provider value={{ destination, setDestination, providers, problem, ready }}>{children}</Context.Provider>;
}

export function folderChoices(nodes: FolderNode[], prefix = ""): { id: string; path: string }[] {
  return nodes.flatMap(node => {
    const path = prefix ? `${prefix} / ${node.name}` : node.name;
    return [{ id: node.id, path }, ...folderChoices(node.children, path)];
  });
}
export function destinationLabel(value: SaveDestination | null, providers: WorkspaceDirectory[]) {
  if (!value) return "请选择资料库和文件夹";
  const provider = providers.find(p => p.registration.library.id === value.libraryId);
  const folder = value.folderId === null ? "未归类"
    : folderChoices(provider?.sidebar?.folders ?? []).find(f => f.id === value.folderId)?.path ?? "目标文件夹不可用";
  return `${provider?.registration.library.name ?? "未登记的资料库"} / ${folder}`;
}
export function destinationAvailable(value: SaveDestination | null, providers: WorkspaceDirectory[]) {
  const provider = providers.find(p => p.registration.library.id === value?.libraryId);
  return !!value && !!provider && !provider.registration.unavailable && !!provider.sidebar
    && (value.folderId === null || folderChoices(provider.sidebar.folders).some(f => f.id === value.folderId));
}

/** Reuses the accepted provider/folder selectors; writing never changes the browse scope. */
export function SaveDestinationPicker({ value, onChange, disabled = false, labelPrefix = "保存到" }: {
  value: SaveDestination | null; onChange: (value: SaveDestination | null) => void;
  disabled?: boolean; labelPrefix?: string;
}) {
  const { providers, problem, ready } = useSaveDestination();
  const provider = providers.find(p => p.registration.library.id === value?.libraryId);
  const paths = providers.map(p => p.registration.library.root);
  const folders = folderChoices(provider?.sidebar?.folders ?? []);
  return <fieldset className="save-destination" disabled={disabled}>
    <legend>保存位置</legend>
    <label>{labelPrefix}资料库
      <select aria-label={`${labelPrefix}资料库`} value={value?.libraryId ?? ""}
        onChange={e => onChange(e.target.value ? { libraryId: e.target.value, folderId: null } : null)}>
        <option value="">请选择资料库…</option>
        {value && !provider && <option value={value.libraryId} disabled>未登记的资料库</option>}
        {providers.map(p => <option key={p.registration.library.id} value={p.registration.library.id}
          disabled={!!p.registration.unavailable || !p.sidebar}>
          {p.registration.library.name} · {libraryPathHint(p.registration.library.root, paths)}
          {p.registration.unavailable ? "（暂时不可用）" : ""}
        </option>)}
      </select>
    </label>
    <label>{labelPrefix}文件夹
      <select aria-label={`${labelPrefix}文件夹`} value={value?.folderId ?? ""}
        disabled={!provider || !!provider.registration.unavailable}
        onChange={e => value && onChange({ ...value, folderId: e.target.value || null })}>
        <option value="">未归类</option>
        {value?.folderId && !folders.some(f => f.id === value.folderId)
          && <option value={value.folderId} disabled>目标文件夹不可用</option>}
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
      </select>
    </label>
    <p className="save-final-position">最终位置：{destinationLabel(value, providers)}</p>
    {provider && <p className="save-library-path" title={provider.registration.library.root}>{provider.registration.library.root}</p>}
    {(!ready || problem) && <p role="status">{problem ?? "正在读取保存位置…"}</p>}
    {value && ready && !destinationAvailable(value, providers)
      && <p role="alert">保存目标不可用。请连接原资料库或重新选择位置。</p>}
  </fieldset>;
}

export function SaveDestinationDialog({ title, confirmLabel = "确认保存", onConfirm, onClose }: {
  title: string; confirmLabel?: string; onConfirm: (value: SaveDestination) => Promise<unknown>; onClose: () => void;
}) {
  const context = useSaveDestination();
  const [value, setValue] = useState(context.destination);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLElement>("select")?.focus();
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="save-destination-overlay">
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={title} className="save-destination-dialog"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
        if (event.key !== "Tab") return;
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled)") ?? [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <h3>{title}</h3>
      <SaveDestinationPicker value={value} onChange={setValue} disabled={busy} />
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy || !context.ready || !destinationAvailable(value, context.providers)}
        onClick={() => {
          if (!value || busy) return;
          const fixed = { ...value };
          context.setDestination(fixed); setBusy(true); setError(null);
          void onConfirm(fixed).then(() => { if (alive.current) onClose(); },
            error => { if (alive.current) setError(String(error)); })
            .finally(() => { if (alive.current) setBusy(false); });
        }}>{busy ? "正在保存…" : confirmLabel}</button>
      <button type="button" disabled={busy} onClick={onClose}>取消</button>
    </section>
  </div>, document.body);
}
