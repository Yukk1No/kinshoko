import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CaptureOverlay } from "./desktop/CaptureOverlay";
import { PinView } from "./desktop/PinView";
import { DesktopMenuView } from "./desktop/PinMenu";
import { FidelityGate } from "./fidelity/FidelityGate";
import { RuntimeProvider } from "./RuntimeSupport";
import "./styles.css";
import "./ui/ui.css";
import "./shell/main-window.css";
import "./ui/dialogs.css";

// 同一个页面承载五种窗口：主窗口、截图框选窗口（?view=capture）、钉图窗口（?view=pin&pin=<id>）、
// 钉图的菜单窗口（?view=desktop-menu，#106）与还原度门槛实验窗口（?view=fidelity-gate）。
const params = new URLSearchParams(location.search);
const view = params.get("view");
const pin = params.get("pin");
document.documentElement.dataset.view = view ?? "main";

// #102 T7：开发模式的帧时间探针，只挂在主窗口。启用条件是 Vite 开发服务器，或构建时显式设置
// VITE_KINSHOKO_PERF=1（用生产构建量帧时间）。条件在构建时折叠为常量，发行构建不含 ./perf。
if ((import.meta.env.DEV || import.meta.env.VITE_KINSHOKO_PERF === "1") && !view) void import("./perf/install").then((m) => m.installPerfProbe(window));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {view === "capture" ? (
      <CaptureOverlay />
    ) : view === "pin" && pin ? (
      <RuntimeProvider><PinView pin={pin} /></RuntimeProvider>
    ) : view === "desktop-menu" ? (
      <DesktopMenuView />
    ) : view === "fidelity-gate" ? (
      <FidelityGate />
    ) : (
      <RuntimeProvider><App /></RuntimeProvider>
    )}
  </StrictMode>,
);
