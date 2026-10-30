import { useEffect, useState } from "react";
import { SearchBox, UI_LANG } from "./search/SearchBox";
import { onLibraryEvent, resolveSearch, setSafeMode } from "./ipc";
import { workspaceFixture } from "./test/workspace-fixture";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowsePage } from "./bindings/BrowsePage";
import type { ImageDetail } from "./bindings/ImageDetail";
import type { LibraryEvent } from "./bindings/LibraryEvent";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { Sidebar } from "./bindings/Sidebar";
import type { RecoveryReport } from "./bindings/RecoveryReport";
import type { Candidate } from "./bindings/Candidate";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import type { TagLabel } from "./bindings/TagLabel";
import { chooseValue } from "./test/select";

// App 的测试共用的后端模拟、数据与操作步骤。

/** 浏览器里的双击：两次按下与单击，再一次 dblclick。双击按第一下的图判定（#179）。 */
export function doubleClick(target: Element) {
  for (const detail of [1, 2]) {
    fireEvent.pointerDown(target, { button: 0 });
    fireEvent.click(target, { detail });
  }
  fireEvent.doubleClick(target, { detail: 2 });
}

export const info: AppInfo = { productName: "Kinshoko", version: "9.9.9" };
export const library: LibraryInfo = { id: "L1", name: "工作参考", root: "D:\\参考\\工作参考" };
export const page: BrowsePage = {
  cards: [
    { id: "a", width: 100, height: 200, thumbnail: "L1/a/256", adult: false },
    { id: "b", width: 300, height: 100, thumbnail: "L1/b/256", adult: false },
  ],
  nextCursor: null,
  total: 2,
};
/** 安全模式关闭时多出一张含成人内容的图。 */
export const released: BrowsePage = {
  cards: [...page.cards, { id: "x", width: 200, height: 200, thumbnail: "L1/x/256", adult: true }],
  nextCursor: null,
  total: 3,
};

export const side: Sidebar = {
  all: 2,
  trash: 1,
  folders: [
    {
      id: "F1",
      name: "人物",
      count: 1,
      children: [{ id: "F2", name: "发型", count: 0, children: [] }],
    },
  ],
};
export const detail = (id: string, manual: string | null): ImageDetail => ({
  id,
  originalName: "参考图",
  collectedAt: 1756571097667,
  sourceLinks: [],
  versions: { previous: null, newer: [] },
  width: 100,
  height: 200,
  folders: [{ id: "F1", name: "人物" }],
  note: { manual, sources: [] },
  deletedAt: null,
  rating: { imageId: id, suggested: null, manual: null, effective: null },
});

export const label = (
  id: string,
  namespace: TagLabel["namespace"],
  name: string,
  hasExternal = false,
): TagLabel => ({
  id,
  namespace,
  name,
  untranslated: false,
  hasExternal,
});
export const tags: Record<string, TagLabel> = {
  A: label("A", "artist", "某某"),
  C: label("C", "character", "某某"),
  B: label("B", "general", "蓝发"),
  Q: label("Q", "general", "水色发", true),
};
/** 模拟的近似对应表：蓝发～水色发（内置）。 */
export const neighbours: Record<string, string[]> = { B: ["Q"], Q: ["B"] };
export const candidates: Candidate[] = [
  { tag: tags.C, via: null, count: 8 },
  { tag: tags.A, via: null, count: 3 },
  { tag: tags.B, via: "某某色", count: 1 },
];

/** 模拟 Search：标签项照 id 填上标签名，文字项匹配名称含这段文字的标签；按 neighbours 近似展开。 */
export function resolved(input: SearchInput): ConditionTree {
  const similar = (ids: string[], dismissed: string[]) =>
    input.exact
      ? []
      : [...new Set(ids.flatMap((id) => neighbours[id] ?? []))]
          .filter((n) => !ids.includes(n) && !dismissed.includes(n))
          .map((n) => ({
            tag: tags[n],
            source: "builtin" as const,
            of: ids.filter((id) => neighbours[id]?.includes(n)),
          }));
  return {
    conditions: input.conditions.map((c) => ({
      negate: c.negate,
      any: c.any.map((t) => {
        if (t.kind === "tag") {
          return { kind: "tag" as const, tag: tags[t.id], similar: similar([t.id], t.dismissed) };
        }
        if (t.kind === "rating") return { kind: "rating" as const, rating: { ratings: t.ratings, name: t.ratings.join("、") } };
        const matched = Object.values(tags).filter((l) => l.name.includes(t.text));
        return {
          kind: "text" as const,
          text: t.text,
          tags: matched,
          similar: similar(
            matched.map((l) => l.id),
            t.dismissed,
          ),
          ratings: [],
        };
      }),
    })),
  };
}

export type Call = { cmd: string; args: unknown };
/** 设置中的“显示相近标签来源”。 */
export let showApproxSource = false;
export let keepSelectionOnSafeMode = false;
export let calls: Call[];
/** 后端的安全模式开关。 */
export let safeOn = true;
/** 后端查不到的图（已删除或被封印）：查询返回 UnknownImage。 */
export let gone = new Set<string>();
/** 测试文件不能给导入的绑定赋值：改共享状态走这几个函数。 */
export const setShowApproxSource = (on: boolean) => { showApproxSource = on; };
export const setKeepSelectionOnSafeMode = (on: boolean) => { keepSelectionOnSafeMode = on; };
export const setCalls = (next: Call[]) => { calls = next; };
export const setSafeOn = (on: boolean) => { safeOn = on; };

export const clean: RecoveryReport = { interrupted: [], orphans: [], discardedStaging: 0 };

export function backend(opened: LibraryInfo | null, recovery: RecoveryReport = clean,
  override?: (cmd: string, args: unknown) => unknown, safe = true) {
  calls = [];
  safeOn = safe;
  gone = new Set();
  mockWindows("main");
  let current = opened;
  let tasks = 0;
  mockIPC(
    workspaceFixture((cmd, args) => {
      calls.push({ cmd, args });
      const overridden = override?.(cmd, args);
      if (overridden !== undefined) return overridden;
      switch (cmd) {
        case "app_info":
          return info;
        case "plugin:library|current_library":
          return current;
        case "plugin:library|create_library":
          current = library;
          return library;
        case "plugin:library|registered_libraries":
          return current ? [{ library: current, unavailable: null }] : [];
        case "plugin:library|register_library":
          current = { id: "L2", name: "私人收藏", root: (args as { root: string }).root };
          return current;
        case "plugin:library|unregister_library":
          current = null;
          return null;
        case "plugin:library|browse":
          return safeOn ? page : released;
        case "plugin:library|safe_mode":
          return safeOn;
        case "plugin:library|set_safe_mode":
          safeOn = (args as { on: boolean }).on;
          return safeOn;
        case "plugin:library|import_tasks":
          return [];
        case "plugin:library|start_import":
          // 后端每个任务的 id 都不同。
          return `T${++tasks}`;
        case "plugin:library|sidebar":
          return side;
        case "plugin:library|image": {
          const { imageId } = args as { imageId: string };
          if (gone.has(imageId)) return Promise.reject("资料库中没有这张参考图");
          return detail(imageId, null);
        }
        case "plugin:library|edit": {
          const { ids, edits } = args as { ids: string[]; edits: { kind: string; text?: string }[] };
          const note = edits.find((e) => e.kind === "setNote")?.text ?? null;
          return ids.map((id) => detail(id, note));
        }
        case "plugin:library|workspace_edit_sources":
          return [];
        case "plugin:library|recovery":
          return recovery;
        case "plugin:library|search_candidates":
          return (args as { text: string }).text.trim() ? candidates : [];
        case "plugin:library|resolve_search":
          return resolved((args as { input: SearchInput }).input);
        case "tagging_status":
          return { libraryId: (args as { libraryId: string }).libraryId, status: { state: "starting" } };
        case "shell_settings":
          return { autostart: true, shortcuts: [], showApproxSource, keepSelectionOnSafeMode };
        default:
          return null;
      }
    }),
    { shouldMockEvents: true },
  );
}

/** Existing library-local approximation controls remain separate until global rules (T06) land. */
export function LocalSearchFixture() {
  const [input, setInput] = useState<SearchInput>({ conditions: [], exact: false });
  const [tree, setTree] = useState<ConditionTree | null>(null);
  const [safe, setSafe] = useState(safeOn);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setSafe((value) => { void setSafeMode(!value); return !value; });
      }
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);
  useEffect(() => {
    const stop = onLibraryEvent((event) => {
      if (event.kind === "safeModeChanged") setSafe(event.on);
      setGeneration((value) => value + 1);
    });
    return () => { void stop.then((stop) => stop()); };
  }, []);
  useEffect(() => {
    let alive = true;
    resolveSearch(library.id, input, UI_LANG, safe).then((tree) => alive && setTree(tree), () => {});
    return () => { alive = false; };
  }, [input, safe, generation]);
  return <>
    <button type="button" aria-label={`安全模式：${safe ? "开启" : "关闭"}`} aria-pressed={safe}
      onClick={() => { setSafe(!safe); void setSafeMode(!safe); }}>安全模式</button>
    <SearchBox libraryId={library.id} safe={safe} generation={generation} input={input} tree={tree}
      showSource={false} onChange={setInput} onError={() => {}} />
  </>;
}

export const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
/** 详情面板里整理选中图的那一块；没有选择时不在。 */
export const selectionPanel = () => screen.queryByLabelText("已选参考图");
/** 多选悬浮栏（#180）：只在选了两张及以上时出现。 */
export const selectionBar = () => screen.queryByRole("toolbar", { name: "已选参考图操作" });
export const push = (event: LibraryEvent) => act(() => emit("library-event", event));
/**
 * 顶栏的导入按钮（设计系统 v2）：一个按钮打开菜单，图片、文件夹与 Eagle 都是菜单项。
 * 打开菜单并返回要点击的那一项。
 */
export const importAction = (name: "导入文件…" | "导入文件夹…" | "从 Eagle 导入…") => {
  fireEvent.click(screen.getByRole("button", { name: /^(导入|正在导入)$/ }));
  return screen.getByRole("menuitem", { name: name === "导入文件…" ? /^图片/ : name === "导入文件夹…" ? /^文件夹/ : /从 Eagle 导入|正在查找 Eagle/ });
};
/** 导入面板里的保存位置为空时选当前库（与原来先选位置再选文件的操作等价）。 */
export const chooseDestination = async () => {
  // 收起的导入面板也保留保存位置选择（hidden）；拖放提示显示的就是它。
  const selector=screen.queryByRole("combobox",{name:"放到图库",hidden:true});
  if(selector&&!selector.dataset.value&&!selector.hasAttribute("disabled"))await chooseValue(selector,"L1");
};
/** 侧栏标题行“图库 ＋”的菜单（方案 D，#113）：打开 / 新建 / 管理，没有图库切换。 */
export const libraryMenu = () => screen.findByRole("button", { name: "打开、新建或管理图库" });
export async function libraryAction(name: RegExp) {
  fireEvent.click(await libraryMenu());
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
/** 从“图库 ＋”打开另一个图库（模拟后端登记为 L2 私人收藏），等图片墙改看它。 */
export async function openLibrary(root = "E:\\私人收藏") {
  window.__KINSHOKO_TEST_PICKS__ = [root];
  await libraryAction(/打开图库/);
  await waitFor(() => expect(sent("plugin:library|browse").at(-1)).toMatchObject({ libraryId: "L2" }));
}
/** 方案 D：选“全部图片”时图库都折起，先点箭头展开。 */
export async function expandLibrary(name = "工作参考") {
  fireEvent.click(await screen.findByRole("button", { name: `展开${name}` }));
}
export async function confirmImport() {
  const button=await screen.findByRole("button",{name:/^开始(?: Eagle)? 导入$|^开始导入$/});
  await chooseDestination();
  await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

beforeEach(() => {
  // jsdom 不做布局：给图片墙一个 1000 × 800 的视口。
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  window.__KINSHOKO_TEST_PICKS__ = [];
  showApproxSource = false;
  keepSelectionOnSafeMode = false;
});

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  vi.unstubAllGlobals();
});

