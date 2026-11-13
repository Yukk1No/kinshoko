import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen, FolderPlus, Library, Plus, RefreshCw, Settings2 } from "lucide-react";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { describeCommandError, errorText } from "../ipc/commandError";
import { onWorkspaceChanged, pickFolder, registeredLibraries, registerLibrary, unregisterLibrary } from "../ipc";
import { BrandMark } from "../ui/BrandMark";
import { Menu, MenuItem, MenuPopup } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import { WarnIcon } from "../ui/WarnIcon";
import { Tip } from "../ui/Tip";
import { offerUndoRemoval } from "./undoRemoval";

/**
 * 本设备的资料库登记与取消登记（界面称“图库”，design/ui-system/interface-terms.md）。
 * `menu`：侧栏标题行“图库 ＋”（方案 D，#113）：＋ 菜单为打开 / 新建 / 管理。画师不选“当前图库”
 * （ADR-0008），这里没有切换；`inline`：还没有图库时的欢迎页（#172 原型 A：先选新建或打开，新建再填表）。
 * 打开菜单或管理对话框时重新读取登记，不可用的登记仍可重新连接（重新检查）或移除。
 */
export function LibraryPicker({ ready = true, onChanged, onCreate, blocked = false, layout = "menu" }: {
  /** 启动时后端还没打开上次的资料库：先不让操作。 */
  ready?: boolean;
  onChanged: (library: LibraryInfo | null) => void;
  onCreate: () => void;
  blocked?: boolean;
  layout?: "menu" | "inline";
}) {
  const { t } = useTranslation("library");
  const [entries, setEntries] = useState<LibraryRegistration[]>([]);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [managing, setManaging] = useState(false);
  const toast = useToast();
  const disabled = busy || blocked || !ready;

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 是重读信号；fail 每次渲染都是新函数，只调 toast
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    registeredLibraries().then(
      (value) => alive && setEntries(value),
      (e) => alive && fail(errorText(e)),
    );
    return () => { alive = false; };
  }, [ready, revision]);

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
    toast.error(message);
  }
  const refresh = () => setRevision((value) => value + 1);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    catch (e) { fail(errorText(e)); }
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
    const entry = entries.find((e) => e.library.id === id);
    await unregisterLibrary(id);
    onChanged(null);
    if (entry && !entry.unavailable) offerUndoRemoval(toast, entry.library,
      (root) => run(async () => onChanged(await registerLibrary(root))), fail);
  });

  const status = <>
    {busy && <span className="sr-only" role="status">{t("picker.busy")}</span>}
  </>;

  if (layout === "inline") return <div className="welcome">
    <section className="welcome-card" aria-labelledby="welcome-title">
      <div className="welcome-head">
        <BrandMark size={48} />
        <h1 id="welcome-title">{t("welcome.title")}</h1>
      </div>
      <div className="welcome-choices">
        <button type="button" className="welcome-choice is-main" disabled={disabled} aria-labelledby="welcome-create" onClick={onCreate}>
          <span className="welcome-choice-tile" aria-hidden="true"><FolderPlus size={20} /></span>
          <span className="welcome-choice-text"><b id="welcome-create">{t("welcome.create")}</b></span>
          <ChevronRight size={16} aria-hidden="true" className="welcome-choice-chev" />
        </button>
        <button type="button" className="welcome-choice" disabled={disabled} aria-labelledby="welcome-open" onClick={() => void register()}>
          <span className="welcome-choice-tile" aria-hidden="true"><FolderOpen size={20} /></span>
          <span className="welcome-choice-text"><b id="welcome-open">{t("welcome.open")}</b></span>
          <ChevronRight size={16} aria-hidden="true" className="welcome-choice-chev" />
        </button>
      </div>
      {status}
    </section>
  </div>;

  return <>
    <div className="pane-library-title">
      <h2 className="pane-title">{t("picker.title")}</h2>
      <Menu.Root modal={false} onOpenChange={(open) => { if (open) refresh(); }}>
        <Tip label={t("picker.addLabel")}><Menu.Trigger className="k-icon-btn lib-add" aria-label={t("picker.addLabel")} disabled={!ready}>
          <Plus size={15} aria-hidden="true" />
        </Menu.Trigger></Tip>
        <MenuPopup width={200} label={t("picker.title")}>
          <MenuItem icon={<FolderOpen size={14} />} disabled={disabled} onClick={() => void register()}>{t("picker.open")}</MenuItem>
          <MenuItem icon={<FolderPlus size={14} />} disabled={disabled} onClick={onCreate}>{t("picker.create")}</MenuItem>
          <MenuItem icon={<Settings2 size={14} />} onClick={() => { refresh(); setManaging(true); }}>{t("picker.manage")}</MenuItem>
        </MenuPopup>
      </Menu.Root>
    </div>
    {status}
    <Dialog.Root open={managing} onOpenChange={setManaging}>
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog library-manage">
          <Dialog.Title className="k-dialog-title">{t("manage.title")}</Dialog.Title>
          {entries.length > 0 ? <ul className="k-list library-list" aria-label={t("manage.listLabel")}>
            {entries.map(({ library, unavailable }) => <li key={library.id} className="k-list-row">
              <span className="k-list-icon" aria-hidden="true"><Library size={16} /></span>
              <div className="k-list-text">
                <div className="k-list-title">{library.name}</div>
                <Tip label={library.root} align="start"><div className="k-list-desc">{library.root}</div></Tip>
                {unavailable && <p className="k-list-desc is-warn" role="status"><WarnIcon />{describeCommandError(unavailable)}</p>}
              </div>
              <div className="k-list-end">
                <span className={`k-pill${unavailable ? " is-warn" : " is-ok"}`}>{unavailable && <WarnIcon />}<span className="k-label">{unavailable ? t("manage.offline") : t("manage.online")}</span></span>
                {unavailable && <button type="button" className="k-btn is-sm" disabled={disabled} onClick={refresh}><RefreshCw size={13} aria-hidden="true" /><span className="k-label">{t("manage.reconnect")}</span></button>}
                <Tip label={t("manage.removeTitle")}><button type="button" className="k-btn is-sm" disabled={disabled} aria-label={t("manage.removeLabel", { name: library.name })}
                  onClick={() => void remove(library.id)}><span className="k-label">{t("manage.remove")}</span></button></Tip>
              </div>
            </li>)}
          </ul> : <p className="k-dialog-desc">{t("manage.none")}</p>}
          <div className="k-dialog-foot">
            <button type="button" className="k-btn" disabled={disabled} onClick={() => void register()}><FolderOpen size={14} aria-hidden="true" /><span className="k-label">{t("picker.open")}</span></button>
            <button type="button" className="k-btn" disabled={disabled} onClick={() => { setManaging(false); onCreate(); }}><FolderPlus size={14} aria-hidden="true" /><span className="k-label">{t("picker.create")}</span></button>
            <span className="k-grow" />
            <Dialog.Close className="k-btn is-primary"><span className="k-label">{t("manage.done")}</span></Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
