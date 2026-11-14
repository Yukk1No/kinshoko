// 质感原型（#606）：主界面三套材质方案，在同一个页面上用 ?variant= 切换（now 是现状，a / b / c 是方案）。
// 页面上跑的是正式程序的 <App />（src/ 原样引用，尺寸与正式程序一致），后端换成 backend.ts 的样本数据；
// 方案只是叠在最后的一张样式表 variants.css，按 <html data-variant> 生效。一次性代码，不进正式程序。
import { createRoot } from "react-dom/client";
import { installBackend } from "./backend";
import { Specimen } from "./Specimen";
import { Switcher, readPose } from "./Switcher";

installBackend();

const pose = readPose();
document.documentElement.dataset.view = "main";
document.documentElement.dataset.variant = pose.variant;
if (pose.theme) document.documentElement.dataset.theme = pose.theme;

// 样式表的顺序与 src/main.tsx 相同，方案的样式表排在最后。
await import("../../../src/styles.css");
await import("../../../src/ui/ui.css");
await import("../../../src/ui/menu.css");
await import("../../../src/ui/toast.css");
await import("../../../src/ui/fields.css");
await import("../../../src/shell/main-window.css");
await import("../../../src/shell/main-window-panels.css");
await import("../../../src/shell/main-window-stacks.css");
await import("../../../src/shell/startup-splash.css");
await import("../../../src/shell/pane-fit.css");
await import("../../../src/ui/settings.css");
await import("../../../src/ui/dialogs.css");
await import("../../../src/search/search-bar.css");
await import("../../../src/ui/text-select.css");
await import("../../../src/subscriptions/subscriptions.css");
await import("./variants.css");

const [{ App }, { RuntimeProvider }, { TipProvider }, { followInterfaceLanguage }] = await Promise.all([
  import("../../../src/App"), import("../../../src/RuntimeSupport"), import("../../../src/ui/Tip"), import("../../../src/i18n"),
]);
followInterfaceLanguage();

createRoot(document.getElementById("root")!).render(
  // 不套 StrictMode：开发模式下它会把图片墙缩略图的 ref 清理多跑一遍，图就不加载了。
  <TipProvider>
    <RuntimeProvider><App /></RuntimeProvider>
    {pose.specimen && <Specimen />}
    {pose.bar && <Switcher pose={pose} />}
  </TipProvider>,
);
