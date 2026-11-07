import { useCaptureSources } from "./desktop/captureSources";
import { onCollectionRequest, takeCollectionRequest } from "./ipc";
import { SaveDestinationProvider } from "./library/SaveDestination";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftClose, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n";
import { ToastProvider, useToast } from "./ui/Toast";
import { WinCtrls } from "./ui/WinCtrls";
import type { AppInfo } from "./bindings/AppInfo";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { WorkspaceStatus } from "./bindings/WorkspaceStatus";
import {
  appInfo,
  openLastLibrary,
  workspaceStatus,
  onWorkspaceChanged,
  onSafeModeSetting,
  safeMode,
  setSafeMode,
  shellSettings,
  setInspectorOpen,
  setInspectorWidth,
  uiScale,
} from "./ipc";
import { useOpenInKinshoko } from "./desktop/openInKinshoko";
import { CaptureHistoryPanel } from "./desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "./desktop/ReferenceGroupsPanel";
import { CreateLibrary, CreateLibraryDialog } from "./library/CreateLibrary";
import { LegacyNameMigrationNotice, LegacyNameWizard } from "./library/LegacyNameMigrationPanel";
import { LibraryPicker } from "./library/LibraryPicker";
import { Rail, type Section } from "./shell/Rail";
import { UiScaleContext } from "./shell/uiScale";
import { useUiScaleChoice } from "./shell/useUiScaleChoice";
import { SettingsPanel, type SettingsTab } from "./SettingsPanel";
import { createShellSettings } from "./shell/useShellSettings";
import { BackupReminder } from "./Backup";
import { Dialog } from "@base-ui/react/dialog";
import { UpdateNotice } from "./Update";
import { RuntimeNotice } from "./RuntimeSupport";
import { INITIAL_SAFE_LENS, needsRecheck, reduceSafeLens, type SafeLensAction } from "./shell/safeLens";
import { safeTiming } from "./shell/safeTiming";
import type { TagDisplay } from "./bindings/TagDisplay";
import { DEFAULT_TAG_DISPLAY } from "./tags/tagConfidence";
import { TagDisplayContext } from "./tags/TagDisplayContext";
import { OpenTagNameSettings } from "./tags/TagNameSettings";

import { LibraryWorkspace } from "./workspace/LibraryWorkspace";
import { markStartup } from "./startupTiming";
import { releaseStartup, startupLibraryOpened } from "./startupGate";
import { StartupSplash } from "./shell/StartupSplash";
import { LoginExpiredNotice, SubscriptionSection, useSubscriptionSection } from "./subscriptions/SubscriptionSection";
import { errorText } from "./ipc/commandError";

/**
 * 主窗口：本设备登记的资料库（#49）；上次的库不可用时仍可选择其他库、重新登记或新建。状态栏可打开截图历史与设置。
 * 封印书或 Ctrl+Shift+S 切换安全模式（#60）：开启的那一刻先遮住将被封印的图，资料库确认后
 * 它们离开图片墙，计数与候选随之刷新。安全模式属于本设备，切换资料库后沿用。
 * Ctrl+= / Ctrl+- / Ctrl+0 按档位放大、缩小、复位界面缩放（#173）。
 * 订阅（#368）是图标轨的第四个分区，见 SubscriptionSection。
 */
export function App() {
  return <ToastProvider><MainWindow /></ToastProvider>;
}

function MainWindow() {
  const { t } = useTranslation("shell");
  useCaptureSources(() => [], -100);
  const toast = useToast();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** 设置打开时先显示的分页：状态栏打开通用，打标图标打开自动标签（#144）。 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsTagFocus, setSettingsTagFocus] = useState<string | undefined>(undefined);
  const openSettings = (tab: SettingsTab, tagFocus?: string) => { setSettingsTab(tab); setSettingsTagFocus(tagFocus); setShowSettings(true); };
  const openTagNameSettings = useCallback((catalogId: string) => { setSettingsTab("tags"); setSettingsTagFocus(catalogId); setShowSettings(true); }, []);
  /** 确认旧名称向导：通知或设置 › 标签打开，叠在当前界面上。 */
  const [nameWizard, setNameWizard] = useState(false);
  const [captureRequest,setCaptureRequest]=useState<{id:string;stamp:number}|null>(null);
  const collectionHandled=useCallback(()=>setCaptureRequest(null),[]);
  const [referenceRequest, setReferenceRequest] = useState<{ libraryId: string; imageId: string; stamp: number } | null>(null);
  const [section, setSection] = useState<Section>("browse");
  const [paneOpen, setPaneOpen] = useState(true);
  const subscriptions = useSubscriptionSection(section, setSection);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 启动时后端打开上次的资料库（成功或失败）之后才进工作区。打开了哪个是后端细节（ADR-0008）。 */
  const [opened, setOpened] = useState(false);
  /** undefined：还没读到登记。 */
  const [hasProviders, setHasProviders] = useState<boolean | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  /** 设置“显示相近标签来源（内置／个人）”，默认不显示。 */
  const [showApproxSource, setShowApproxSource] = useState(false);
  const [keepSelectionOnSafe, setKeepSelectionOnSafe] = useState(false);
  /** 标签外观（#160）：详情面板与查看器从上下文读取，设置一改立即生效。 */
  const [tagDisplay, setTagDisplay] = useState<TagDisplay>(DEFAULT_TAG_DISPLAY);
  const [inspectorWidth, setInspectorWidthState] = useState<number | undefined>(undefined);
  const [inspectorShown, setInspectorShownState] = useState(false);
  const inspectorChosen = useRef(false);
  /** `keepInspector`：启动时读到的快照回得晚，画师这次已亲手开合过详情面板，就不拿它盖回去。 */
  const acceptShellSettings = useCallback((view: ShellSettingsView, keepInspector = false) => {
    setShowApproxSource(view.showApproxSource);
    setTagDisplay(view.tagDisplay ?? DEFAULT_TAG_DISPLAY);
    setKeepSelectionOnSafe(view.keepSelectionOnSafeMode ?? false);
    setInspectorWidthState(view.inspectorWidth);
    if (!keepInspector) setInspectorShownState(view.inspectorOpen ?? false);
  }, []);
  /** 设置页交来过快照后，启动时读到的那份已经旧了，回得晚也不再接受（#321）。 */
  const settingsChanged = useRef(false);
  const acceptChangedSettings = useCallback((view: ShellSettingsView) => {
    settingsChanged.current = true;
    acceptShellSettings(view);
  }, [acceptShellSettings]);
  const [shellSettingsStore] = useState(() => createShellSettings(acceptChangedSettings));
  /** 详情面板宽度先在界面上生效，再写进本设备设置；写不进时只是下次不记得。 */
  const changeInspectorWidth = useCallback((width: number) => {
    setInspectorWidthState(width);
    void setInspectorWidth(width).catch(() => {});
  }, []);
  /** 详情面板的开合同样先生效再写设置。 */
  const changeInspectorShown = useCallback((open: boolean) => {
    inspectorChosen.current = true;
    setInspectorShownState(open);
    void setInspectorOpen(open).catch(() => {});
  }, []);
  const { uiScalePercent, uiScaleWriting, acceptUiScale, chooseUiScale } = useUiScaleChoice(toast);
  /**
   * 安全模式。读到设置之前按开启处理，不会先露出被封印的图。`safe` 是开关上显示的状态；
   * 查询资料库用 `lensSafe`：关闭时等后端确认才放开（#183，见 safeLens）。
   */
  const [safeState, setSafeState] = useState(INITIAL_SAFE_LENS);
  const safeStateRef = useRef(safeState);
  const applySafe = useCallback((action: SafeLensAction) => {
    safeStateRef.current = reduceSafeLens(safeStateRef.current, action);
    setSafeState(safeStateRef.current);
  }, []);
  const { shown: safe, lens: lensSafe } = safeState;
  const acceptSafe = useCallback((on: boolean) => applySafe({ kind: "external", on }), [applySafe]);
  /** 以后端保存的设置为准；读不到时按开启处理。 */
  const recheckSafe = useCallback(() => {
    safeMode().then(
      (on) => acceptSafe(on !== false),
      () => acceptSafe(true),
    );
  }, [acceptSafe]);
  const toggleSafe = useCallback(() => {
    // 不等后端：这一帧就开始遮蔽（或打开封印书）。
    applySafe({ kind: "toggle" });
    const next = safeStateRef.current.shown;
    safeTiming.toggled(next);
    setSafeMode(next).then(
      (on) => {
        safeTiming.mark("backend-confirmed");
        applySafe({ kind: "settled", on });
        // 快速连点时返回可能乱序：与最后一次点击不一致就读一次设置校准。
        if (needsRecheck(safeStateRef.current, on)) recheckSafe();
      },
      (e) => {
        applySafe({ kind: "failed" });
        toast.error(i18n.t("shell:safeMode.toggleFailed", { error: errorText(e) }));
        recheckSafe();
      },
    );
  }, [toast, applySafe, recheckSafe]);

  // 钉图菜单“在 Kinshoko 中打开”（#106）：参考图在查看器里打开，截图打开截图历史。
  useOpenInKinshoko((request) => {
    if (request.kind === "capture") { setSection("captures"); setPaneOpen(true); return; }
    // 查看器在图片与文件夹的工作区里：正开着订阅页时先回去，不然打开了也看不见。
    setSection((current) => (current === "subscriptions" ? "browse" : current));
    setReferenceRequest((last) => ({ libraryId: request.libraryId, imageId: request.imageId, stamp: (last?.stamp ?? 0) + 1 }));
  });

  useEffect(()=>{
    let alive=true,stamp=0,sequence=0;
    const accept=()=>{const request=++sequence;void takeCollectionRequest().then(id=>{if(alive&&request===sequence&&id){setCaptureRequest({id,stamp:++stamp});setSection("captures");setPaneOpen(true);}});};
    const stop=onCollectionRequest(accept).then(fn=>{if(alive)accept();return fn;});
    return()=>{alive=false;void stop.then(fn=>fn());};
  },[]);

  useEffect(() => {
    let alive = true;
    appInfo().then((value) => alive && setInfo(value));
    safeMode().then(
      (on) => alive && acceptSafe(on !== false),
      () => {},
    );
    shellSettings().then(
      (view) => alive && view && !settingsChanged.current && acceptShellSettings(view, inspectorChosen.current),
      () => undefined,
    );
    uiScale().then(
      (saved) => { if (alive && typeof saved === "number" && !uiScaleWriting.current) acceptUiScale(saved); },
      () => undefined,
    );
    openLastLibrary().then(
      () => {
        markStartup("libraryOpened");
        startupLibraryOpened();
        if (alive) setOpened(true);
      },
      (e) => {
        // 打不开就不等首屏：进主界面，由图库选择页处理。
        releaseStartup();
        if (!alive) return;
        setOpenError(errorText(e));
        setOpened(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // 上次的图库打不开：报告一次，留到画师确认（原常驻横幅，#98）。
  useEffect(() => {
    if (!openError) return;
    const id = toast.error(i18n.t("shell:openFailed", { error: openError }));
    return () => toast.close(id);
  }, [openError, toast]);

  useEffect(() => {
    let alive = true;
    const accept = (status: WorkspaceStatus) => { if (alive) setHasProviders(status.libraries.length > 0); };
    // 读不到时进工作区，由它显示读取错误。
    workspaceStatus(lensSafe).then(accept, () => { if (alive) setHasProviders((known) => known ?? true); });
    const stop = onWorkspaceChanged(accept);
    return () => { alive = false; void stop.then((stop) => stop()); };
  }, [lensSafe]);

  useEffect(() => {
    const stop = onSafeModeSetting(acceptSafe);
    return () => { void stop.then((stop) => stop()); };
  }, [acceptSafe]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggleSafe();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSafe]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "b") { e.preventDefault(); setPaneOpen((open) => !open); }
      if (["1", "2", "3"].includes(e.key) || (e.key === "4" && subscriptions.onRef.current)) {
        e.preventDefault(); setSection((["browse", "groups", "captures", "subscriptions"] as Section[])[Number(e.key) - 1]); setPaneOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changed = (added: LibraryInfo | null) => {
    if (added) setHasProviders(true);
    workspaceStatus(lensSafe).then((status) => setHasProviders(status.libraries.length > 0), () => {});
    setOpenError(null);
    setShowCreate(false);
  };

  const libraryControls = <LibraryPicker ready={opened} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />;
  // 还没有图库时新建是整页引导；已有图库时是对话框，图片墙留着（#442）。
  const createPage = showCreate && !hasProviders;
  const empty = hasProviders === false || createPage;
  // 没有图片墙可等（还没有图库）：加载页直接放行（#338）。
  useEffect(() => { if (opened && empty) releaseStartup(); }, [opened, empty]);
  return (
    <UiScaleContext.Provider value={uiScalePercent / 100}>
    <TagDisplayContext.Provider value={tagDisplay}><OpenTagNameSettings.Provider value={openTagNameSettings}><SaveDestinationProvider safe={lensSafe}><div className="app app-shell">
      <div className="rail-slot">
        <Rail section={section} paneOpen={paneOpen} safeMode={safe} onSafeMode={toggleSafe}
          onSection={(next) => { if (next === section) setPaneOpen((open) => !open); else { setSection(next); setPaneOpen(true); } }}
          onSettings={() => { if (showSettings) setShowSettings(false); else openSettings("general"); }}
          subscriptions={subscriptions.rail} />
      </div>
      <div className="app-column">
      {opened && (
        <LibraryWorkspace
          key="workspace"
          captureRequest={captureRequest}
          onCaptureRequestHandled={collectionHandled}
          referenceRequest={referenceRequest}
          section={section}
          paneOpen={paneOpen}
          onPaneToggle={() => setPaneOpen((open) => !open)}
          onPaneOpen={setPaneOpen}
          onOpenBrowse={() => { setSection("browse"); setPaneOpen(true); }}
          libraryControls={libraryControls}
          hidden={empty || subscriptions.page !== null}
          safe={lensSafe}
          onSafeChanged={acceptSafe}
          showApproxSource={showApproxSource}
          keepSelectionOnSafe={keepSelectionOnSafe}
          inspectorWidth={inspectorWidth}
          onInspectorWidth={changeInspectorWidth}
          inspectorShown={inspectorShown}
          onInspectorShown={changeInspectorShown}
          onLibraryRemoved={() => changed(null)}
          onOpenTaggingSettings={() => openSettings("tagging")}
        />
      )}
      <SubscriptionSection subscriptions={subscriptions} safe={lensSafe} paneOpen={paneOpen} onPaneToggle={() => setPaneOpen((open) => !open)}
        onOpenImage={(libraryId, imageId) => {
          setSection("browse"); setPaneOpen(true);
          setReferenceRequest((last) => ({ libraryId, imageId, stamp: (last?.stamp ?? 0) + 1 }));
        }} />
      {empty && !subscriptions.page && (
        <div className="app-empty-workspace">
          {!hasProviders && paneOpen && section !== "browse" && <aside className="pane empty-context" aria-label={section === "groups" ? t("emptyPane.groups") : t("emptyPane.capturesLabel")}>
            <header className="pane-head" data-tauri-drag-region><h2 className="pane-title">{section === "groups" ? t("emptyPane.groups") : t("emptyPane.captures")}</h2>
              <button type="button" className="k-icon-btn" aria-label={t("emptyPane.collapse")} title={t("emptyPane.collapse")} onClick={() => setPaneOpen(false)}><PanelLeftClose size={16} aria-hidden="true" /></button></header>
            {section === "groups" ? <ReferenceGroupsPanel /> : <CaptureHistoryPanel request={captureRequest} onRequestHandled={collectionHandled} />}
          </aside>}
        <main className="app-main app-main-centered">
          <header className="topbar is-empty" data-tauri-drag-region><span className="k-grow" /><WinCtrls /></header>
          <div className="app-empty-body">
          {!opened ? (
            <p role="status">{t("opening")}</p>
          ) : createPage ? (
            <CreateLibrary onCreated={changed} onBusyChange={setCreating} onBack={() => setShowCreate(false)} backLabel={t("back")} />
          ) : (
            <LibraryPicker layout="inline" ready={opened} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />
          )}
          </div>
        </main>
        </div>
      )}
      {showCreate && hasProviders && <CreateLibraryDialog opens onClose={() => setShowCreate(false)} onCreated={changed} onBusyChange={setCreating} />}
      <Dialog.Root open={showSettings} onOpenChange={setShowSettings}>
        <Dialog.Portal>
          <Dialog.Backdrop className="k-backdrop" />
          <Dialog.Popup className="k-dialog k-settings-dialog">
            <Dialog.Title className="sr-only">{t("settingsTitle")}</Dialog.Title>
            {/* 关闭按钮不归设置面板管：读取中或读取失败时也在。 */}
            <Dialog.Close className="k-icon-btn k-dialog-x" aria-label={t("closeSettings")}><X size={16} aria-hidden="true" /></Dialog.Close>
            <SettingsPanel
              version={info && `${info.productName} ${info.version}`}
              hasLibrary={!!hasProviders}
              initialTab={settingsTab}
              initialTagFocus={settingsTagFocus}
              safe={safe}
              onSafeMode={toggleSafe}
              onOpenNameWizard={() => setNameWizard(true)}
              settings={shellSettingsStore}
              uiScale={uiScalePercent}
              onUiScale={(percent) => void chooseUiScale(percent)}
              subscriptions={subscriptions.settings}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <LegacyNameWizard open={nameWizard} onOpenChange={setNameWizard} />
      {opened && <>
        <RuntimeNotice hidden={showSettings} onOpen={() => openSettings("diag")} />
        <LegacyNameMigrationNotice safe={lensSafe} enabled={!!hasProviders} hidden={showSettings || nameWizard} onOpen={() => setNameWizard(true)} />
        <LoginExpiredNotice subscriptions={subscriptions} hidden={showSettings} />
        <UpdateNotice />
        <BackupReminder />
      </>}
      <StartupSplash />
      </div>
    </div></SaveDestinationProvider></OpenTagNameSettings.Provider></TagDisplayContext.Provider>
    </UiScaleContext.Provider>
  );
}
