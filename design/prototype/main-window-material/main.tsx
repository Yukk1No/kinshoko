// 质感原型（#606）：主界面三套材质方案，在同一个页面上用 ?variant= 切换（now 是现状，a / b / c 是第一轮的方案，c2 之后是在 C 上迭代的）。
// 页面上跑的是正式程序的 <App />（src/ 原样引用，尺寸与正式程序一致），后端换成 backend.ts 的样本数据；
// 方案只是叠在最后的一张样式表 variants.css，按 <html data-variant> 生效。一次性代码，不进正式程序。
import { createRoot } from "react-dom/client";
import { installBackend } from "./backend";
import { mountFolders } from "./Folders";
import { mountTree } from "./Tree";
import { mountGroups } from "./Groups";
import { Specimen } from "./Specimen";
import { Switcher, readPose } from "./Switcher";

installBackend();

const pose = readPose();
document.documentElement.dataset.view = "main";
// 第十轮：左栏的行（ra–re）叠在 PR #635 的正式样式上，前几轮的方案样式不参与，所以 data-variant 记成 now。
const rows = /^r[a-e]$/.test(pose.variant);
document.documentElement.dataset.variant = rows ? "now" : pose.variant;
if (rows) document.documentElement.dataset.rows = pose.variant;
if (pose.theme) document.documentElement.dataset.theme = pose.theme;

// 样式表的顺序与 src/main.tsx 相同，方案的样式表排在最后。
await import("../../../src/styles.css");
await import("../../../src/library/selection.css");
await import("../../../src/viewer/viewer.css");
await import("../../../src/search/search.css");
await import("../../../src/desktop/capture-history.css");
await import("../../../src/desktop/capture.css");
await import("../../../src/fidelity/fidelity-gate.css");
await import("../../../src/library/tag-panel.css");
await import("../../../src/shell/sidebar-base.css");
await import("../../../src/shell/rail.css");
await import("../../../src/shell/seal-fx.css");
await import("../../../src/search/tag-groups.css");
await import("../../../src/library/import.css");
await import("../../../src/library/legacy-name-migration.css");
await import("../../../src/ui/ui.css");
await import("../../../src/ui/empty-state.css");
await import("../../../src/ui/token.css");
await import("../../../src/ui/spinner.css");
await import("../../../src/ui/ui-dock.css");
await import("../../../src/ui/menu.css");
await import("../../../src/ui/toast.css");
await import("../../../src/ui/fields.css");
await import("../../../src/ui/row.css");
await import("../../../src/shell/main-window.css");
await import("../../../src/shell/sidebar.css");
await import("../../../src/shell/main-window-island.css");
await import("../../../src/shell/inspector.css");
await import("../../../src/shell/welcome.css");
await import("../../../src/shell/main-window-tags.css");
await import("../../../src/wall/wall.css");
await import("../../../src/shell/startup-splash.css");
await import("../../../src/desktop/desk-groups.css");
await import("../../../src/settings/settings.css");
await import("../../../src/ui/dialogs.css");
await import("../../../src/ui/dialogs-tasks.css");
await import("../../../src/search/search-bar.css");
await import("../../../src/ui/text-select.css");
await import("../../../src/subscriptions/subscriptions.css");
await import("./variants.css");
await import("./rows.css");

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
// 第四轮：标签分组的两种新摆法。
if (pose.variant === "c4a") mountGroups("panel");
if (pose.variant === "c4b") mountGroups("side");
if (pose.variant === "c4c") mountGroups("inline");
// 第六轮：C4d 在 C4c 上改查找框的选中样子与文件夹视图，并给文件夹加上拖动排序。
if (["c4d", "c4e", "c4f", "c4g", "c4h"].includes(pose.variant)) { mountGroups("inline"); mountFolders(); }
// 第八轮：子文件夹的层级。C4f、C4g 在 C4e 上加折叠与新的缩进，见 Tree.ts。
if (["c4f", "c4g", "c4h"].includes(pose.variant)) mountTree();
