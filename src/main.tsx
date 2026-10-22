import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CaptureOverlay } from "./desktop/CaptureOverlay";
import { PinLayer } from "./desktop/PinLayer";
import { DesktopMenuView } from "./desktop/PinMenu";
import { FidelityGate } from "./fidelity/FidelityGate";
import { RuntimeProvider } from "./RuntimeSupport";
import { recordUncaughtErrors } from "./runLog";
import { blockBrowserMenu } from "./ui/browserMenu";
import "./styles.css";
import "./ui/ui.css";
import "./shell/main-window.css";
// 设置早于 dialogs.css：后者减弱动效的规则要盖过设置页签的过渡。
import "./ui/settings.css";
import "./ui/dialogs.css";
import "./ui/text-select.css";

// 同一个页面承载五种窗口：主窗口、截图框选窗口（?view=capture）、钉图层（?view=pin-layer，#193）、
// 钉图的菜单窗口（?view=desktop-menu，#106）与还原度门槛实验窗口（?view=fidelity-gate）。
const params = new URLSearchParams(location.search);
const view = params.get("view");
document.documentElement.dataset.view = view ?? "main";
// 每种窗口都不弹 WebView 自带的浏览器菜单（#229）。
blockBrowserMenu(window);
// 没有接住的错误记进运行日志（#219）。
recordUncaughtErrors(window);

// #102 T7：开发模式的帧时间探针，只挂在主窗口。启用条件是 Vite 开发服务器，或构建时显式设置
// VITE_KINSHOKO_PERF=1（用生产构建量帧时间）。条件在构建时折叠为常量，发行构建不含 ./perf。
if ((import.meta.env.DEV || import.meta.env.VITE_KINSHOKO_PERF === "1") && !view) void import("./perf/install").then((m) => m.installPerfProbe(window));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {view === "capture" ? (
      <CaptureOverlay />
    ) : view === "pin-layer" ? (
      <RuntimeProvider><PinLayer /></RuntimeProvider>
    ) : view === "desktop-menu" ? (
      <DesktopMenuView />
    ) : view === "fidelity-gate" ? (
      <FidelityGate />
    ) : (
      <RuntimeProvider><App /></RuntimeProvider>
    )}
  </StrictMode>,
);
