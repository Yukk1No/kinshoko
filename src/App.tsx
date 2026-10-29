import { useCaptureSources } from "./desktop/captureSources";
import { onCollectionRequest, takeCollectionRequest } from "./ipc";
import { SaveDestinationProvider } from "./library/SaveDestination";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftClose, X } from "lucide-react";
import { ToastProvider, useToast } from "./ui/Toast";
import { WinCtrls } from "./ui/WinCtrls";
import type { AppInfo } from "./bindings/AppInfo";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { WorkspaceStatus } from "./bindings/WorkspaceStatus";
import {
  appInfo,
  currentLibrary,
  workspaceStatus,
  onWorkspaceChanged,
  onSafeModeSetting,
  safeMode,
  setSafeMode,
  setUiScale,
  shellSettings,
  setInspectorWidth,
  uiScale,
} from "./ipc";
import { useOpenInKinshoko } from "./desktop/openInKinshoko";
import { CaptureHistoryPanel } from "./desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "./desktop/ReferenceGroupsPanel";
import { CreateLibrary } from "./library/CreateLibrary";
import { LegacyNameMigrationNotice, LegacyNameWizard } from "./library/LegacyNameMigrationPanel";
import { LibraryPicker } from "./library/LibraryPicker";
import { Rail, type Section } from "./shell/Rail";
import { initialUiScale, stepUiScale, UiScaleContext, uiScaleStepForKey } from "./shell/uiScale";
import { SettingsPanel, type SettingsTab } from "./SettingsPanel";
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

/**
 * 主窗口：本设备登记的资料库与一个活动资料库（#49）；上次的库不可用时仍可选择其他库、
 * 重新登记或新建。状态栏可打开截图历史与设置。
 * 封印书或 Ctrl+Shift+S 切换安全模式（#60）：开启的那一刻先遮住将被封印的图，资料库确认后
 * 它们离开图片墙，计数与候选随之刷新。安全模式属于本设备，切换资料库后沿用。
 * Ctrl+= / Ctrl+- / Ctrl+0 按档位放大、缩小、复位界面缩放（#173）。
 */
export function App() {
  return <ToastProvider><MainWindow /></ToastProvider>;
}

function MainWindow() {
  useCaptureSources(() => [], -100);
  const toast = useToast();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** 设置打开时先显示的分页：状态栏打开通用，打标图标打开自动标签（#144）。 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsTagFocus, setSettingsTagFocus] = useState<string | undefined>(undefined);
  const openSettings = (tab: SettingsTab, tagFocus?: string) => { setSettingsTab(tab); setSettingsTagFocus(tagFocus); setShowSettings(true); };
  const openTagNameSettings = useCallback((catalogId: string) => { setSettingsTab("tags"); setSettingsTagFocus(catalogId); setShowSettings(true); }, []);
  /** 确认旧名称向导：横幅或设置 › 标签的提示条打开，叠在当前界面上。 */
  const [nameWizard, setNameWizard] = useState(false);
  const [captureRequest,setCaptureRequest]=useState<{id:string;stamp:number}|null>(null);
  const collectionHandled=useCallback(()=>setCaptureRequest(null),[]);
  const [referenceRequest, setReferenceRequest] = useState<{ libraryId: string; imageId: string; stamp: number } | null>(null);
  const [section, setSection] = useState<Section>("browse");
  const [paneOpen, setPaneOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  // undefined：还在打开；null：没有活动资料库。
  const [library, setLibrary] = useState<LibraryInfo | null | undefined>(undefined);
  const [hasProviders, setHasProviders] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /** 设置“显示相近标签来源（内置／个人）”，默认不显示。 */
  const [showApproxSource, setShowApproxSource] = useState(false);
  const [keepSelectionOnSafe, setKeepSelectionOnSafe] = useState(false);
  /** 标签外观（#160）：详情面板与查看器从上下文读取，设置一改立即生效。 */
  const [tagDisplay, setTagDisplay] = useState<TagDisplay>(DEFAULT_TAG_DISPLAY);
  const [inspectorWidth, setInspectorWidthState] = useState<number | undefined>(undefined);
  const acceptShellSettings = useCallback((view: ShellSettingsView) => {
    setShowApproxSource(view.showApproxSource);
    setTagDisplay(view.tagDisplay ?? DEFAULT_TAG_DISPLAY);
    setKeepSelectionOnSafe(view.keepSelectionOnSafeMode ?? false);
    setInspectorWidthState(view.inspectorWidth);
  }, []);
  /** 详情面板宽度先在界面上生效，再写进本设备设置；写不进时只是下次不记得。 */
  const changeInspectorWidth = useCallback((width: number) => {
    setInspectorWidthState(width);
    void setInspectorWidth(width).catch(() => {});
  }, []);
  /**
   * 界面缩放档位（#173）。WebView 由核心缩放，这里只记下档位给图片墙和设置用：
   * 显示的档位在核心保存并缩放之后才换；连按时从最后按下的那一档往下数。
   * 写入一次只发一个：上一个完成后若又按了别的档，再写最后按到的那一档，旧的写入不会盖过新的。
   */
  const [uiScalePercent, setUiScalePercent] = useState(initialUiScale);
  const uiScaleTarget = useRef(uiScalePercent);
  const uiScaleSaved = useRef(uiScalePercent);
  const uiScaleWriting = useRef(false);
  const acceptUiScale = useCallback((saved: number) => {
    uiScaleSaved.current = saved;
    uiScaleTarget.current = saved;
    setUiScalePercent(saved);
  }, []);
  const chooseUiScale = useCallback(async (percent: number) => {
    if (percent === uiScaleTarget.current) return;
    uiScaleTarget.current = percent;
    if (uiScaleWriting.current) return;
    uiScaleWriting.current = true;
    try {
      while (uiScaleTarget.current !== uiScaleSaved.current) {
        const wanted = uiScaleTarget.current;
        try {
          const saved = await setUiScale(wanted);
          uiScaleSaved.current = saved;
          if (uiScaleTarget.current === wanted) acceptUiScale(saved);
        } catch (e) {
          toast?.error(`无法更改界面缩放：${String(e)}`);
          acceptUiScale(await uiScale().catch(() => uiScaleSaved.current));
        }
      }
    } finally {
      uiScaleWriting.current = false;
    }
  }, [toast, acceptUiScale]);
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
        safeTiming.mark("后端确认");
        applySafe({ kind: "settled", on });
        // 快速连点时返回可能乱序：与最后一次点击不一致就读一次设置校准。
        if (needsRecheck(safeStateRef.current, on)) recheckSafe();
      },
      (e) => {
        applySafe({ kind: "failed" });
        toast?.error(`无法切换安全模式：${String(e)}`);
        recheckSafe();
      },
    );
  }, [toast, applySafe, recheckSafe]);

  // 钉图菜单“在 Kinshoko 中打开”（#106）：参考图在查看器里打开，截图打开截图历史。
  useOpenInKinshoko((request) => {
    if (request.kind === "capture") { setSection("captures"); setPaneOpen(true); return; }
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
      (view) => alive && view && acceptShellSettings(view),
      () => undefined,
    );
    uiScale().then(
      (saved) => { if (alive && typeof saved === "number" && !uiScaleWriting.current) acceptUiScale(saved); },
      () => undefined,
    );
    currentLibrary().then(
      (value) => {
        markStartup("libraryOpened");
        startupLibraryOpened();
        if (alive) setLibrary(value);
      },
      (e) => {
        // 打不开就不等首屏：进主界面，由图库选择页处理。
        releaseStartup();
        if (!alive) return;
        setOpenError(String(e));
        setLibrary(null);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // 上次的图库打不开：报告一次，留到画师确认（原常驻横幅，#98）。
  useEffect(() => {
    if (!openError || !toast) return;
    const id = toast.error(`上次的图库无法打开：${openError}`);
    return () => toast.close(id);
  }, [openError, toast]);

  useEffect(() => {
    let alive = true;
    const accept = (status: WorkspaceStatus) => { if (alive) setHasProviders(status.libraries.length > 0); };
    workspaceStatus(lensSafe).then(accept, () => {});
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

  // 界面缩放的固定按键；Ctrl+滚轮不在这里，它归图片墙的图片大小（#111）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = uiScaleStepForKey(e);
      if (!step) return;
      e.preventDefault();
      void chooseUiScale(stepUiScale(uiScaleTarget.current, step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chooseUiScale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "b") { e.preventDefault(); setPaneOpen((open) => !open); }
      if (["1", "2", "3"].includes(e.key)) {
        e.preventDefault(); setSection((["browse", "groups", "captures"] as Section[])[Number(e.key) - 1]); setPaneOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changed = (value: LibraryInfo | null) => {
    setLibrary(value);
    workspaceStatus(lensSafe).then((status) => setHasProviders(status.libraries.length > 0), () => {});
    setOpenError(null);
    setShowCreate(false);
  };

  const libraryControls = <LibraryPicker current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />;
  const empty = (!library && !hasProviders) || showCreate;
  // 没有图片墙可等（还没有图库）：加载页直接放行（#338）。
  useEffect(() => { if (library !== undefined && empty) releaseStartup(); }, [library, empty]);
  const notices = <>
    <RuntimeNotice hidden={showSettings} />
    {library && <div><LegacyNameMigrationNotice libraryId={library.id} safe={lensSafe} onOpen={() => setNameWizard(true)} /></div>}
    <UpdateNotice />
    <BackupReminder />
  </>;
  return (
    <UiScaleContext.Provider value={uiScalePercent / 100}>
    <TagDisplayContext.Provider value={tagDisplay}><OpenTagNameSettings.Provider value={openTagNameSettings}><SaveDestinationProvider safe={lensSafe}><div className="app app-shell">
      <div className="rail-slot">
        <Rail section={section} paneOpen={paneOpen} safeMode={safe} onSafeMode={toggleSafe}
          onSection={(next) => { if (next === section) setPaneOpen((open) => !open); else { setSection(next); setPaneOpen(true); } }}
          onSettings={() => { if (showSettings) setShowSettings(false); else openSettings("general"); }} />
      </div>
      <div className="app-column">
      {library !== undefined && (
        <LibraryWorkspace
          key="workspace"
          library={library}
          captureRequest={captureRequest}
          onCaptureRequestHandled={collectionHandled}
          referenceRequest={referenceRequest}
          section={section}
          paneOpen={paneOpen}
          onPaneToggle={() => setPaneOpen((open) => !open)}
          onPaneOpen={setPaneOpen}
          onOpenBrowse={() => { setSection("browse"); setPaneOpen(true); }}
          libraryControls={libraryControls}
          hidden={empty}
          safe={lensSafe}
          onSafeChanged={acceptSafe}
          showApproxSource={showApproxSource}
          keepSelectionOnSafe={keepSelectionOnSafe}
          inspectorWidth={inspectorWidth}
          onInspectorWidth={changeInspectorWidth}
          notices={!empty && notices}
          onLibraryRemoved={(id) => { if (library?.id === id) changed(null); }}
          onOpenTaggingSettings={() => openSettings("tagging")}
        />
      )}
      {empty && (
        <div className="app-empty-workspace">
          {!library && paneOpen && section !== "browse" && <aside className="pane empty-context" aria-label={section === "groups" ? "参考组" : "截图历史"}>
            <header className="pane-head" data-tauri-drag-region><h2 className="pane-title">{section === "groups" ? "参考组" : "截图"}</h2>
              <button type="button" className="k-icon-btn" aria-label="收起侧栏" title="收起侧栏" onClick={() => setPaneOpen(false)}><PanelLeftClose size={16} aria-hidden="true" /></button></header>
            {section === "groups" ? <ReferenceGroupsPanel libraryId={undefined} /> : <CaptureHistoryPanel libraryId={undefined} request={captureRequest} onRequestHandled={collectionHandled} />}
          </aside>}
        <main className="app-main app-main-centered">
          <header className="topbar is-empty" data-tauri-drag-region><span className="k-grow" /><WinCtrls /></header>
          {empty && notices}
          <div className="app-empty-body">
          {library === undefined ? (
            <p role="status">正在打开图库…</p>
          ) : showCreate ? (
            <CreateLibrary onCreated={changed} onBusyChange={setCreating} onBack={() => setShowCreate(false)} backLabel={library ? "返回图库" : "返回"} />
          ) : (
            <LibraryPicker layout="inline" current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />
          )}
          </div>
        </main>
        </div>
      )}
      <Dialog.Root open={showSettings} onOpenChange={setShowSettings}>
        <Dialog.Portal>
          <Dialog.Backdrop className="k-backdrop" />
          <Dialog.Popup className="k-dialog k-settings-dialog">
            <Dialog.Title className="sr-only">程序设置</Dialog.Title>
            {/* 关闭按钮不归设置面板管：读取中或读取失败时也在。 */}
            <Dialog.Close className="k-icon-btn k-dialog-x" aria-label="关闭设置"><X size={16} aria-hidden="true" /></Dialog.Close>
            <SettingsPanel
              version={info && `${info.productName} ${info.version}`}
              library={library ?? null}
              initialTab={settingsTab}
              initialTagFocus={settingsTagFocus}
              safe={safe}
              onSafeMode={toggleSafe}
              onOpenNameWizard={() => setNameWizard(true)}
              onChange={acceptShellSettings}
              uiScale={uiScalePercent}
              onUiScale={(percent) => void chooseUiScale(percent)}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <LegacyNameWizard open={nameWizard} onOpenChange={setNameWizard} />
      <StartupSplash />
      </div>
    </div></SaveDestinationProvider></OpenTagNameSettings.Provider></TagDisplayContext.Provider>
    </UiScaleContext.Provider>
  );
}
