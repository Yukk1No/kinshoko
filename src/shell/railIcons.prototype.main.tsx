// PROTOTYPE（图标轨图标）：在浏览器里用模拟的后端跑主窗口，看新图标放进界面的样子。
// 打开 rail-prototype.html；底部浮条或 ← → 切换订阅图标（写进 `?subs=`）。选定后删掉这几个 prototype 文件。
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { workspaceFixture } from "../test/workspace-fixture";
import { SUBSCRIPTION_ICONS, subscriptionIcon } from "./railIcons.prototype";

const library = { id: "L1", name: "工作参考", root: "D:\\参考\\工作参考" };
const sizes = [[3, 4], [4, 3], [2, 3], [1, 1], [16, 9], [3, 5], [4, 5], [9, 16]];
const cards = Array.from({ length: 48 }, (_, i) => {
  const [w, h] = sizes[(i * 5) % sizes.length];
  return { id: `p${i}`, width: w * 300, height: h * 300, thumbnail: `L1/p${i}/256`, adult: false };
});
const side = {
  all: cards.length, trash: 2,
  folders: [
    { id: "F1", name: "人物", count: 18, children: [{ id: "F2", name: "发型", count: 6, children: [] }, { id: "F3", name: "手", count: 4, children: [] }] },
    { id: "F4", name: "场景", count: 12, children: [] },
    { id: "F5", name: "服装", count: 9, children: [] },
  ],
};
const status = {
  enabled: true, login: { state: "loggedIn", account: { userId: "1", name: "yuki_sub", explicitAllowed: true } },
  signingIn: false, checking: false, newCount: 5, backoffUntil: null,
};

mockWindows("main");
mockIPC(workspaceFixture((cmd) => {
  switch (cmd) {
    case "app_info": return { productName: "Kinshoko", version: "prototype" };
    case "plugin:library|current_library": return library;
    case "plugin:library|registered_libraries": return [{ library, unavailable: null }];
    case "plugin:library|browse": return { cards, nextCursor: null, total: cards.length };
    case "plugin:library|safe_mode": return true;
    case "plugin:library|import_tasks": return [];
    case "plugin:library|sidebar": return side;
    case "plugin:library|recovery": return { interrupted: [], orphans: [], discardedStaging: 0 };
    case "plugin:library|search_candidates": return [];
    case "plugin:library|workspace_edit_sources": return [];
    case "plugin:desktop|reference_groups": return [1, 2, 3].map((n) => ({ id: `g${n}`, name: `参考组 ${n}` }));
    case "plugin:desktop|capture_history": return Array.from({ length: 12 }, (_, n) => ({ id: `c${n}` }));
    case "plugin:desktop|take_open_request": return null;
    case "subscription_status": return status;
    case "subscriptions": case "subscription_recent": return [];
    case "tagging_status": return { state: "starting" };
    case "shell_settings": return { autostart: true, shortcuts: [], showApproxSource: false, keepSelectionOnSafeMode: false, inspectorOpen: false };
    default: return null;
  }
}), { shouldMockEvents: true });
// 缩略图走 vite.rail-prototype.config.ts 里生成色块的地址。
(window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string, protocol: string) => string } })
  .__TAURI_INTERNALS__.convertFileSrc = (_path, protocol) => `/__proto/${protocol}/`;

type Choice = { id: string; name: string };
const button = { all: "unset", cursor: "pointer", padding: "4px 10px", fontSize: 16 } as const;
/** 一行候选：← → 换一个，写进地址参数后重新载入。 */
function Row({ label, param, list, current, keys }: { label: string; param: string; list: Choice[]; current: Choice; keys: [string, string] }) {
  const index = list.indexOf(current);
  const go = (step: number) => {
    const url = new URL(location.href);
    url.searchParams.set(param, list[(index + step + list.length) % list.length].id);
    location.href = url.toString();
  };
  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
    if (e.key === keys[0]) go(-1);
    if (e.key === keys[1]) go(1);
  });
  return <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <button type="button" style={button} onClick={() => go(-1)}>←</button>
    <span style={{ minWidth: 260, textAlign: "center" }}>{label} {index + 1}/{list.length}：{current.name}</span>
    <button type="button" style={button} onClick={() => go(1)}>→</button>
  </div>;
}

function Switcher() {
  return <div style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 9999, display: "flex", flexDirection: "column", gap: 2,
    padding: "6px 8px", borderRadius: 18, background: "#111", color: "#fff", font: "13px system-ui", boxShadow: "0 6px 20px rgba(0,0,0,.35)" }}>
    <Row label="订阅图标（← →）" param="subs" list={SUBSCRIPTION_ICONS} current={subscriptionIcon} keys={["ArrowLeft", "ArrowRight"]} />
  </div>;
}

// 开发模式（StrictMode）会把卡片的 ref 回调多跑一遍，撤掉还没到的缩略图地址；原型里按卡片编号补回去。
setInterval(() => {
  for (const img of document.querySelectorAll<HTMLImageElement>(".card img:not([src])")) {
    const id = img.closest<HTMLElement>(".card")?.dataset.id;
    if (id) img.src = `/__proto/thumb/L1/${id}/256`;
  }
}, 300);

const bar = document.createElement("div");
document.body.appendChild(bar);
createRoot(bar).render(<Switcher />);
await import("../main");
