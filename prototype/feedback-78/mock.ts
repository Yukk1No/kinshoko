// PROTOTYPE（#78 人工验收反馈 4 / 9）：在浏览器里用假数据跑正式主窗口。不进产品，不测后端语义。
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { workspaceFixture } from "../../src/test/workspace-fixture";
import type { ImageCard } from "../../src/bindings/ImageCard";
import type { LibraryInfo } from "../../src/bindings/LibraryInfo";
import type { Sidebar } from "../../src/bindings/Sidebar";

const hues = [[280, 320], [140, 170], [20, 40], [200, 230], [340, 10], [45, 60], [250, 290], [100, 160]];
function thumb(seed: number, w: number, h: number) {
  const [a, b] = hues[seed % hues.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>`
    + `<radialGradient id="g" cx="${30 + (seed * 37) % 50}%" cy="${20 + (seed * 53) % 50}%" r="90%">`
    + `<stop offset="0" stop-color="hsl(${a} 55% 82%)"/><stop offset=".55" stop-color="hsl(${(a + b) / 2} 35% 62%)"/>`
    + `<stop offset="1" stop-color="hsl(${b} 30% 42%)"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function cards(prefix: string, n: number, seed0: number): ImageCard[] {
  return Array.from({ length: n }, (_, i) => {
    const s = seed0 + i;
    const ratio = [0.66, 0.75, 1, 1.33, 0.56, 1.5, 0.8][(s * 7) % 7];
    const w = 600, h = Math.round(600 / ratio);
    return { id: `${prefix}${i}`, width: w, height: h, thumbnail: thumb(s, 60, Math.round(60 / ratio)), adult: false };
  });
}

const libraries: { info: LibraryInfo; unavailable: string | null; side: Sidebar; cards: ImageCard[] }[] = [
  {
    info: { id: "L1", name: "角色参考", root: "D:\\参考\\角色参考" }, unavailable: null,
    side: { all: 148, trash: 2, folders: [
      { id: "F1", name: "人物", count: 41, children: [{ id: "F2", name: "发型", count: 18, children: [] }, { id: "F3", name: "表情", count: 13, children: [] }] },
      { id: "F4", name: "服装", count: 36, children: [] },
      { id: "F5", name: "姿势", count: 22, children: [] },
    ] },
    cards: cards("a", 148, 0),
  },
  {
    info: { id: "L2", name: "画法练习", root: "E:\\练习\\画法练习" }, unavailable: null,
    side: { all: 43, trash: 0, folders: [
      { id: "G1", name: "画法", count: 43, children: [{ id: "G2", name: "厚涂", count: 12, children: [] }] },
      { id: "G3", name: "光影", count: 27, children: [] },
      { id: "G4", name: "背景", count: 12, children: [] },
    ] },
    cards: cards("b", 43, 50),
  },
  {
    info: { id: "L4", name: "场景与道具", root: "D:\\参考\\场景与道具" }, unavailable: null,
    side: { all: 312, trash: 5, folders: [
      { id: "H1", name: "建筑", count: 88, children: [{ id: "H2", name: "和风", count: 31, children: [] }, { id: "H3", name: "西式", count: 40, children: [{ id: "H4", name: "教堂", count: 9, children: [] }] }] },
      { id: "H5", name: "室内", count: 74, children: [] },
      { id: "H6", name: "武器", count: 51, children: [] },
      { id: "H7", name: "交通工具", count: 29, children: [] },
      { id: "H8", name: "自然", count: 70, children: [{ id: "H9", name: "天空", count: 33, children: [] }] },
    ] },
    cards: cards("d", 120, 200),
  },
  {
    info: { id: "L5", name: "同人收藏", root: "E:\\收藏\\同人" }, unavailable: null,
    side: { all: 96, trash: 0, folders: [
      { id: "J1", name: "作品 A", count: 40, children: [] }, { id: "J2", name: "作品 B", count: 31, children: [] }, { id: "J3", name: "作品 C", count: 25, children: [] },
    ] },
    cards: cards("e", 96, 400),
  },
  {
    info: { id: "L3", name: "旧素材", root: "F:\\移动盘\\旧素材" }, unavailable: "找不到这个文件夹，可能在移动盘上。",
    side: { all: 0, trash: 0, folders: [] }, cards: [],
  },
];
let active: LibraryInfo = libraries[0].info;
const byId = (id: string) => libraries.find((l) => l.info.id === id) ?? libraries[0];

export function installMocks() {
  mockWindows("main");
  // 缩略图地址直接是 data URL：thumbnailUrl = convertFileSrc("", "thumb") + address。
  (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: () => string } }).__TAURI_INTERNALS__.convertFileSrc = () => "";
  mockIPC(workspaceFixture((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, any>;
    switch (cmd) {
      case "app_info": return { productName: "Kinshoko", version: "prototype" };
      case "plugin:library|current_library": return active;
      case "plugin:library|switch_library": active = byId(args.libraryId ?? args.id).info; return active;
      case "plugin:library|registered_libraries": return libraries.map((l) => ({ library: l.info, unavailable: l.unavailable }));
      case "plugin:library|sidebar": return byId(args.libraryId).side;
      case "plugin:library|browse": {
        const lib = args.libraryId ? byId(args.libraryId) : null;
        const all = lib ? lib.cards : libraries.flatMap((l) => l.cards);
        return { cards: all, nextCursor: null, total: all.length };
      }
      case "plugin:library|safe_mode": return true;
      case "plugin:library|import_tasks": return [];
      case "plugin:library|recovery": return { interrupted: [], orphans: [], discardedStaging: 0 };
      case "plugin:library|search_candidates": return [];
      case "plugin:library|resolve_search": return { conditions: [] };
      case "plugin:library|tag_groups": return [];
      case "tagging_status": return { libraryId: args.libraryId, status: { state: "running", done: 32, total: 120 } };
      case "shell_settings": return { autostart: true, shortcuts: [], showApproxSource: false, keepSelectionOnSafeMode: false };
      default: return null;
    }
  }), { shouldMockEvents: true });
}
