// PROTOTYPE（#78 反馈 4 / 9）。运行：npm run proto:78，然后打开 http://127.0.0.1:1478/
import { createRoot } from "react-dom/client";
import { installMocks } from "./mock";
import { App } from "../../src/App";
import { RuntimeProvider } from "../../src/RuntimeSupport";
import "../../src/styles.css";
import "../../src/ui/ui.css";
import "../../src/shell/main-window.css";
import "../../src/ui/dialogs.css";
import "./variants.css";
import { Switcher } from "./Switcher";
import { ProtoExact } from "./ProtoExact";

installMocks();
const params = new URLSearchParams(location.search);
document.documentElement.dataset.bar = params.get("bar") ?? "0";
document.documentElement.dataset.side = params.get("side") ?? "0";
document.documentElement.dataset.view = "main";

// 滑条已走过的一段用 --fill 画出来（原生 range 没有这个伪元素）。
const fill = (el: HTMLInputElement) => el.style.setProperty("--fill", `${((+el.value - +el.min) / (+el.max - +el.min)) * 100}%`);
document.addEventListener("input", (e) => { if ((e.target as HTMLInputElement).type === "range") fill(e.target as HTMLInputElement); });
new MutationObserver(() => document.querySelectorAll<HTMLInputElement>("input[type=range]").forEach(fill))
  .observe(document.body, { childList: true, subtree: true });

createRoot(document.getElementById("root")!).render(<>
  <RuntimeProvider><App /></RuntimeProvider>
  <ProtoExact />
  <Switcher />
</>);
