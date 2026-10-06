import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CaptureOverlay } from "./desktop/CaptureOverlay";
import { PinView } from "./desktop/PinView";
import "./styles.css";

// 同一个页面承载三种窗口：主窗口、截图框选窗口（?view=capture）、钉图窗口（?view=pin&pin=<id>）。
const params = new URLSearchParams(location.search);
const view = params.get("view");
const pin = params.get("pin");
document.documentElement.dataset.view = view ?? "main";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {view === "capture" ? <CaptureOverlay /> : view === "pin" && pin ? <PinView pin={pin} /> : <App />}
  </StrictMode>,
);
