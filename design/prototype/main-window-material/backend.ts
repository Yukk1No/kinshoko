// 原型用的假后端：正式程序的界面照常运行，Tauri 命令在这里按命令名回答固定的样本数据。只读，不保存任何东西。
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type Args = Record<string, unknown>;
type Reply = (args: Args) => unknown;

const libraries = [
  { id: "L1", name: "工作参考", root: "D:\\参考\\工作参考" },
  { id: "L2", name: "私人收藏", root: "E:\\私人收藏" },
];
const registrations = libraries.map((library) => ({ library, unavailable: null }));
const status = { revision: "prototype", libraries: registrations };

const folder = (id: string, name: string, count: number, children: unknown[] = []) => ({ id, name, count, children });
const sidebars: Record<string, unknown> = {
  L1: {
    all: 1284, trash: 12,
    folders: [
      folder("F1", "人物", 412, [folder("F11", "发型", 96), folder("F12", "表情", 58), folder("F13", "手", 133)]),
      folder("F2", "服装", 207, [folder("F21", "制服", 64), folder("F22", "和服", 41)]),
      folder("F3", "背景", 318),
      folder("F4", "光影", 126),
      folder("F5", "构图", 89),
    ],
  },
  L2: { all: 356, trash: 0, folders: [folder("G1", "色彩", 120), folder("G2", "质感", 77)] },
};

/** 样张的宽高；编号决定色块的颜色（见 vite.config.ts）。 */
const shapes = [[3, 4], [4, 3], [1, 1], [2, 3], [16, 9], [3, 5], [5, 4], [3, 4], [9, 16], [4, 5], [1, 1], [7, 5]];
const cards = Array.from({ length: 96 }, (_, index) => {
  const [w, h] = shapes[index % shapes.length];
  const width = w * 300, height = h * 300;
  const imageId = `p${index + 1}-${width}x${height}`;
  return {
    id: imageId, width, height, adult: false, libraryId: "L1", imageId,
    sources: [{ libraryId: "L1", libraryName: "工作参考", imageId, unavailable: null, matches: true, deleted: false }],
  };
});

const tag = (id: string, name: string, count: number) => ({ tag: { id, namespace: "general", name, untranslated: false, hasExternal: true }, count });
export const groups = [
  { id: "g-hair", name: "发色", namespace: null, tags: [tag("t1", "蓝发", 86), tag("t2", "银发", 64), tag("t3", "黑发", 211), tag("t4", "金发", 97)] },
  { id: "g-eyes", name: "瞳色", namespace: null, tags: [tag("t5", "蓝瞳", 132), tag("t6", "红瞳", 71), tag("t7", "金瞳", 40)] },
  { id: "g-light", name: "光线", namespace: null, tags: [tag("t8", "逆光", 58), tag("t9", "侧光", 44)] },
  { id: "g-pose", name: "姿势", namespace: null, tags: [tag("t10", "坐姿", 120), tag("t11", "回头", 37)] },
];

const settings = {
  autostart: false, shortcuts: [], showApproxSource: false, forceSrgb: false, forceSrgbInEffect: false, runLog: false,
  keepSelectionOnSafeMode: false, pinEdgeContrast: false, safeModeScope: "questionable",
  // 详情栏默认收起，与正式程序相同；?inspector=1 时打开（#606 要看空的详情栏）。
  tagDisplay: { style: "bands", high: 0.8, low: 0.4 }, inspectorOpen: new URLSearchParams(location.search).get("inspector") === "1", inspectorWidth: 320, updateChannel: "stable",
};

const replies: Record<string, Reply> = {
  app_info: () => ({ productName: "Kinshoko", version: "原型" }),
  open_last_library: () => libraries[0],
  current_library: () => libraries[0],
  registered_libraries: () => registrations,
  workspace_status: () => status,
  workspace_directories: () => ({
    status, registrationOrder: libraries.map((library) => library.id),
    providers: registrations.map((registration) => ({ registration, unassigned: registration.library.id === "L1" ? 37 : 4, descendants: {}, sidebar: sidebars[registration.library.id] })),
  }),
  workspace_sidebar: (args) => sidebars[(args.libraryId as string) ?? "L1"],
  workspace_browse: () => ({ cards, nextCursor: null, total: 1640, status }),
  workspace_tag_groups: () => groups,
  shared_tag_groups: () => [],
  workspace_local_tags: (args) => args.ids,
  workspace_candidates: () => [],
  workspace_library_candidates: () => [],
  search_candidates: () => [],
  rating_candidates: () => [],
  // 查找条件照 id 填上标签名，查找框里因此显示真的条件；不做近似展开。
  workspace_resolve: (args) => ({
    conditions: (args.input as { conditions: { negate: boolean; any: { kind: string; id?: string; text?: string }[] }[] }).conditions.map((condition) => ({
      negate: condition.negate,
      any: condition.any.map((term) => term.kind === "tag"
        ? { kind: "tag", tag: groups.flatMap((group) => group.tags).find(({ tag }) => tag.id === term.id)?.tag, similar: [] }
        : { kind: "text", text: term.text ?? "", tags: [], similar: [], ratings: [] }),
    })),
  }),
  safe_mode: () => true,
  set_safe_mode: (args) => args.on,
  shell_settings: () => settings,
  change_setting: () => settings,
  ui_scale: () => 100,
  import_tasks: () => [],
  import_contains_eagle: () => false,
  save_memory: () => ({ importDestination: null, newLibraryParent: null }),
  recovery: () => ({ interrupted: [], orphans: [], discardedStaging: 0 }),
  tagging_status: () => ({ state: "idle", model: "PixAI Tagger v1.0", device: "gpu", gpu: null, tagged: 1640, unknown: 0, failed: { count: 0, sample: [] } }),
  capture_history: () => [],
  take_collection_request: () => null,
  reference_groups: () => [],
  interface_language: () => "zh-CN",
  subscription_status: () => ({ enabled: true, login: { state: "loggedOut" }, signingIn: false, checking: false, newCount: 0, backoffUntil: null }),
  take_open_request: () => null,
  double_click: () => null,
  plan_legacy_names: () => ({ plan: { libraries: [], entries: [], groups: [] }, libraries: registrations }),
  update_status: () => ({ state: "upToDate" }),
  backup_status: () => ({ plan: { target: null, selection: { kind: "all" }, lastSuccess: null, lastSnapshot: null, lastFailure: null, due: false }, running: null, lastReport: null }),
  log_timing: () => null,
  log_frontend: () => null,
  runtime_status: () => null,
};

/** 没登记的命令：记下名字，原型启动后在控制台里能看到还缺哪些。 */
export const missing = new Set<string>();

export function installBackend() {
  mockWindows("main");
  mockConvertFileSrc("windows");
  mockIPC(async (command, args) => {
    const name = command.replace(/^plugin:[^|]+\|/, "");
    const reply = replies[name];
    if (reply) return reply((args ?? {}) as Args);
    // 窗口、事件等插件命令：原型里没有原生窗口，一律当作“没有、没变化”。
    if (command.startsWith("plugin:") && !command.startsWith("plugin:library|") && !command.startsWith("plugin:desktop|")) {
      if (/is_|has_/.test(name)) return false;
      if (name === "scale_factor") return window.devicePixelRatio;
      return null;
    }
    if (!missing.has(command)) { missing.add(command); console.warn("[prototype] no reply for", command, args); }
    throw { code: "prototype" };
  }, { shouldMockEvents: true });
  // 缩略图走开发服务器的色块样张。
  (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (path: string, protocol?: string) => string } }).__TAURI_INTERNALS__.convertFileSrc = () => "/__thumb/";
}
