import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Folder, Library } from "lucide-react";
import type { SaveDestination } from "../bindings/SaveDestination";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import type { FolderNode } from "../bindings/FolderNode";
import { isCursorExpired, onWorkspaceChanged, workspaceDirectories } from "../ipc";
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
        if (!alive || request !== sequence) return;
        // 读取期间修订变了：结果已过时，按新修订重读，不把它当作问题显示（#98）。
        if (isCursorExpired(error)) { refresh(); return; }
        setProblem(String(error)); setReady(false);
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
  if (!value) return "请选择图库和文件夹";
  const provider = providers.find(p => p.registration.library.id === value.libraryId);
  const folder = value.folderId === null ? "未归类"
    : folderChoices(provider?.sidebar?.folders ?? []).find(f => f.id === value.folderId)?.path ?? "这个文件夹不在了";
  return `${provider?.registration.library.name ?? "未打开的图库"} / ${folder}`;
}
export function destinationAvailable(value: SaveDestination | null, providers: WorkspaceDirectory[]) {
  const provider = providers.find(p => p.registration.library.id === value?.libraryId);
  return !!value && !!provider && !provider.registration.unavailable && !!provider.sidebar
    && (value.folderId === null || folderChoices(provider.sidebar.folders).some(f => f.id === value.folderId));
}

/**
 * 保存位置（#98）：并排两个选择——图库与文件夹；写入从不改变浏览范围。
 * 读屏名称保留“保存到资料库 / 保存到文件夹”，供本机验收脚本按名称找到它们。
 */
export function SaveDestinationPicker({ value, onChange, disabled = false, labelPrefix = "" }: {
  value: SaveDestination | null; onChange: (value: SaveDestination | null) => void;
  disabled?: boolean; labelPrefix?: string;
}) {
  const { providers, problem, ready } = useSaveDestination();
  const provider = providers.find(p => p.registration.library.id === value?.libraryId);
  const paths = providers.map(p => p.registration.library.root);
  const folders = folderChoices(provider?.sidebar?.folders ?? []);
  return <fieldset className="save-destination k-destination" disabled={disabled}>
    <legend className="sr-only">保存位置</legend>
    <div className="k-destination-grid">
      <label className="k-field">
        <span className="k-field-label">{labelPrefix}图库</span>
        <span className="k-select-wrap"><Library size={15} aria-hidden="true" />
        <select className="k-select is-lg" aria-label="保存到资料库" value={value?.libraryId ?? ""}
          onChange={e => onChange(e.target.value ? { libraryId: e.target.value, folderId: null } : null)}>
          <option value="">选择图库…</option>
          {value && !provider && <option value={value.libraryId} disabled>未打开的图库</option>}
          {providers.map(p => <option key={p.registration.library.id} value={p.registration.library.id}
            disabled={!!p.registration.unavailable || !p.sidebar}>
            {p.registration.library.name} · {libraryPathHint(p.registration.library.root, paths)}
            {p.registration.unavailable ? "（未连接）" : ""}
          </option>)}
        </select></span>
      </label>
      <label className="k-field">
        <span className="k-field-label">文件夹</span>
        <span className="k-select-wrap"><Folder size={15} aria-hidden="true" />
        <select className="k-select is-lg" aria-label="保存到文件夹" value={value?.folderId ?? ""}
          disabled={!provider || !!provider.registration.unavailable}
          onChange={e => value && onChange({ ...value, folderId: e.target.value || null })}>
          <option value="">未归类</option>
          {value?.folderId && !folders.some(f => f.id === value.folderId)
            && <option value={value.folderId} disabled>这个文件夹不在了</option>}
          {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
        </select></span>
      </label>
    </div>
    {value && <p className="save-final-position k-set-note" title={provider?.registration.library.root}>放到：{destinationLabel(value, providers)}</p>}
    {(!ready || problem) && <p className="k-set-note" role="status">{problem ?? "正在读取图库…"}</p>}
    {value && ready && !destinationAvailable(value, providers)
      && <p className="k-set-error" role="alert">这个位置现在用不了。请接上原图库，或换一个位置。</p>}
  </fieldset>;
}

/**
 * 选好保存位置再执行的对话框（收藏截图、复制到、导入参考组包）。`description` 与 `summary`
 * 是标题下的一句说明和要保存的内容（例如截图缩略图与尺寸）。
 */
export function SaveDestinationDialog({ title, description, summary, confirmLabel = "保存", onConfirm, onClose }: {
  title: string; description?: string; summary?: ReactNode; confirmLabel?: string; onConfirm: (value: SaveDestination) => Promise<unknown>; onClose: () => void;
}) {
  const context = useSaveDestination();
  const [value, setValue] = useState(context.destination);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog k-save-dialog save-destination-dialog">
        <Dialog.Title className="k-dialog-title">{title}</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">{description ?? "选好图库和文件夹。"}</Dialog.Description>
        {summary && <div className="k-import-summary">{summary}</div>}
        <SaveDestinationPicker value={value} onChange={setValue} disabled={busy} />
        {error && <p className="k-set-error" role="alert">{error}</p>}
        <div className="k-dialog-foot">
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="k-btn is-primary" disabled={busy || !context.ready || !destinationAvailable(value, context.providers)}
            onClick={() => {
              if (!value || busy) return;
              const fixed = { ...value };
              context.setDestination(fixed); setBusy(true); setError(null);
              void onConfirm(fixed).then(() => { if (alive.current) onClose(); },
                error => { if (alive.current) setError(String(error)); })
                .finally(() => { if (alive.current) setBusy(false); });
            }}>{busy ? "正在保存…" : confirmLabel}</button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
