import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import "../src/styles.css";
import "../src/ui/ui.css";
import "../src/ui/fields.css";
import "../src/shell/main-window.css";
import "../src/shell/main-window-panels.css";
import "../src/ui/settings.css";
import "../src/ui/dialogs.css";
import "../src/search/search-bar.css";
import "../src/ui/text-select.css";
import { TagGroupsDialog } from "../src/workspace/TagGroupsDialog";

const p = new URLSearchParams(location.search);
if (p.get("theme")) document.documentElement.dataset.theme = p.get("theme")!;
const t = (id: string, name: string, namespace = "general", untranslated = false) => ({ id, name, namespace, untranslated, hasExternal: true });
let groups: any[] = [
  { id: "G1", name: "发色", namespace: null, tags: [
    { tag: t("a", "蓝发"), count: 128 }, { tag: t("b", "紫发"), count: 42 }, { tag: t("c", "银发"), count: 77 },
    { tag: t("d", "gradient hair", "general", true), count: 9 }, { tag: t("e", "双色发"), count: 15 }],
    sources: [{ libraryId: "A", libraryName: "角色参考", groupId: "x", groupName: "发色" }] },
  { id: "G2", name: "光影", namespace: null, tags: [{ tag: t("f", "逆光"), count: 230 }, { tag: t("g", "边缘光"), count: 61 }, { tag: t("h", "体积光"), count: 18 }], sources: [] },
  { id: "G3", name: "作者", namespace: "artist", tags: [{ tag: t("i", "米山舞", "artist"), count: 54 }, { tag: t("j", "redjuice", "artist"), count: 31 }], sources: [] },
  { id: "G4", name: "待整理", namespace: null, tags: [], sources: [] },
];
if (p.get("empty")) groups = [];
const cands = [
  { tag: t("k", "蓝眼"), via: null, count: 312 }, { tag: t("l", "天蓝色"), via: null, count: 20 },
  { tag: t("m", "猫耳"), via: "neko", count: 88 }, { tag: t("n", "blue theme", "general", true), via: null, count: 6 },
];
mockWindows("main");
mockIPC((cmd: string) => {
  if (cmd === "plugin:library|shared_tag_groups") return groups;
  if (cmd === "plugin:library|workspace_candidates") return cands;
  return null;
}, { shouldMockEvents: true });
createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", background: "var(--bg)" }}>
    <TagGroupsDialog open onOpenChange={() => {}} safe generation={0} onBrowse={() => {}} onError={(e) => console.error(e)} />
  </div>,
);
