import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronRight, FolderOpen, FolderPlus, Library, Lightbulb, Pin, Plus, RefreshCw, Settings2 } from "lucide-react";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { onWorkspaceChanged, pickFolder, registeredLibraries, registerLibrary, unregisterLibrary } from "../ipc";
import { BrandMark } from "../ui/BrandMark";
import { Menu, MenuItem, MenuPopup } from "../ui/Menu";
import { useToast } from "../ui/Toast";

/**
 * 本设备的资料库登记与取消登记（界面称“图库”，design/ui-system/copy-map.md）。
 * `menu`：侧栏标题行“图库 ＋”（方案 D，#113）：＋ 菜单为打开 / 新建 / 管理。画师不选“当前图库”
 * （ADR-0008），这里没有切换；`inline`：还没有图库时的欢迎页（#172 原型 A：先选新建或打开，新建再填表）。
 * 打开菜单或管理对话框时重新读取登记，不可用的登记仍可重新连接（重新检查）或移除。
 */
export function LibraryPicker({ current, onChanged, onCreate, blocked = false, layout = "menu" }: {
  current: LibraryInfo | null | undefined;
  onChanged: (library: LibraryInfo | null) => void;
  onCreate: () => void;
  blocked?: boolean;
  layout?: "menu" | "inline";
}) {
  const [entries, setEntries] = useState<LibraryRegistration[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [managing, setManaging] = useState(false);
  const toast = useToast();
  const disabled = busy || blocked || current === undefined;

  useEffect(() => {
    if (current === undefined) return;
    let alive = true;
    registeredLibraries().then(
      (value) => alive && setEntries(value),
      (e) => alive && fail(String(e)),
    );
    return () => { alive = false; };
  }, [current?.id, current?.root, current === undefined, revision]);

  // Registrations can also change outside this picker (content restore, unregistration elsewhere).
  // Re-read the list when the workspace's provider set changes.
  useEffect(() => {
    let ids: string | null = null;
    const stop = onWorkspaceChanged((status) => {
      const next = status.libraries.map((entry) => entry.library.id).sort().join("|");
      if (ids !== null && next === ids) return;
      ids = next;
      setRevision((value) => value + 1);
    });
    return () => { void stop.then((unlisten) => unlisten()); };
  }, []);

  function fail(message: string) {
    if (toast) toast.error(message); else setError(message);
  }
  const refresh = () => setRevision((value) => value + 1);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (e) { fail(String(e)); }
    finally {
      setBusy(false);
      refresh();
    }
  };

  const register = () => run(async () => {
    const root = await pickFolder();
    if (root) onChanged(await registerLibrary(root));
  });
  const remove = (id: string) => run(async () => {
    await unregisterLibrary(id);
    if (current?.id === id) onChanged(null);
  });

  const status = <>
    {busy && <span className="sr-only" role="status">正在处理图库…</span>}
    {error && <p className="library-error" role="alert">{error}</p>}
  </>;

  if (layout === "inline") return <div className="welcome">
    <section className="welcome-card" aria-labelledby="welcome-title">
      <div className="welcome-head">
        <BrandMark size={48} />
        <h1 id="welcome-title">欢迎使用 Kinshoko</h1>
        <p>先准备一个图库，用来存放参考图。</p>
      </div>
      <div className="welcome-choices">
        <button type="button" className="welcome-choice is-main" disabled={disabled} aria-labelledby="welcome-create" aria-describedby="welcome-create-desc" onClick={onCreate}>
          <span className="welcome-choice-tile" aria-hidden="true"><FolderPlus size={20} /></span>
          <span className="welcome-choice-text"><b id="welcome-create">新建图库</b><span id="welcome-create-desc">在你选的位置新建文件夹</span></span>
          <ChevronRight size={16} aria-hidden="true" className="welcome-choice-chev" />
        </button>
        <button type="button" className="welcome-choice" disabled={disabled} aria-labelledby="welcome-open" aria-describedby="welcome-open-desc" onClick={() => void register()}>
          <span className="welcome-choice-tile" aria-hidden="true"><FolderOpen size={20} /></span>
          <span className="welcome-choice-text"><b id="welcome-open">打开图库</b><span id="welcome-open-desc">选择已有图库所在的文件夹</span></span>
          <ChevronRight size={16} aria-hidden="true" className="welcome-choice-chev" />
        </button>
      </div>
      {status}
    </section>
    <div className="welcome-tips">
      <p className="welcome-tip"><Lightbulb size={14} aria-hidden="true" />用过 Eagle？建好图库后从“导入”迁入</p>
      <p className="welcome-tip"><Pin size={14} aria-hidden="true" />截图和钉图不需要图库，随时可用</p>
    </div>
  </div>;

  return <>
    <div className="pane-library-title">
      <h2 className="pane-title">图库</h2>
      <Menu.Root modal={false} onOpenChange={(open) => { if (open) refresh(); }}>
        <Menu.Trigger className="k-icon-btn lib-add" aria-label="打开、新建或管理图库" title="打开、新建或管理图库" disabled={current === undefined}>
          <Plus size={15} aria-hidden="true" />
        </Menu.Trigger>
        <MenuPopup width={200} label="图库">
          <MenuItem icon={<FolderOpen size={14} />} disabled={disabled} onClick={() => void register()}>打开图库…</MenuItem>
          <MenuItem icon={<FolderPlus size={14} />} disabled={disabled} onClick={onCreate}>新建图库…</MenuItem>
          <MenuItem icon={<Settings2 size={14} />} onClick={() => { refresh(); setManaging(true); }}>管理图库</MenuItem>
        </MenuPopup>
      </Menu.Root>
    </div>
    {status}
    <Dialog.Root open={managing} onOpenChange={setManaging}>
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog library-manage">
          <Dialog.Title className="k-dialog-title">管理图库</Dialog.Title>
          <Dialog.Description className="k-dialog-desc">移除只是不再显示，文件不会删除。</Dialog.Description>
          {entries.length > 0 ? <ul className="k-list library-list" aria-label="本设备的图库">
            {entries.map(({ library, unavailable }) => <li key={library.id} className="k-list-row">
              <span className="k-list-icon" aria-hidden="true"><Library size={16} /></span>
              <div className="k-list-text">
                <div className="k-list-title">{library.name}</div>
                <div className="k-list-desc" title={library.root}>{library.root}</div>
                {unavailable && <p className="k-list-desc is-warn" role="status">{unavailable}</p>}
              </div>
              <div className="k-list-end">
                <span className={`k-pill${unavailable ? " is-warn" : " is-ok"}`}>{unavailable ? "未连接" : "已连接"}</span>
                {unavailable && <button type="button" className="k-btn is-sm" disabled={disabled} onClick={refresh}><RefreshCw size={13} aria-hidden="true" />重新连接</button>}
                <button type="button" className="k-btn is-sm" disabled={disabled} aria-label={`移除 ${library.name}`}
                  title="不再显示；文件不删，未完成的导入会取消" onClick={() => void remove(library.id)}>移除</button>
              </div>
            </li>)}
          </ul> : <p className="k-dialog-desc">还没有打开的图库。</p>}
          <div className="k-dialog-foot">
            <button type="button" className="k-btn" disabled={disabled} onClick={() => void register()}><FolderOpen size={14} aria-hidden="true" />打开图库…</button>
            <button type="button" className="k-btn" disabled={disabled} onClick={() => { setManaging(false); onCreate(); }}><FolderPlus size={14} aria-hidden="true" />新建图库…</button>
            <span className="k-grow" />
            <Dialog.Close className="k-btn is-primary">完成</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
