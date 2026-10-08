import { useEffect, useState } from "react";
import { SearchBox, UI_LANG } from "./search/SearchBox";
import { onLibraryEvent, resolveSearch, setSafeMode } from "./ipc";
import { workspaceFixture } from "./test/workspace-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { App } from "./App";

const info: AppInfo = { productName: "Kinshoko", version: "9.9.9" };
const library: LibraryInfo = { id: "L1", name: "工作参考", root: "D:\\参考\\工作参考" };
const page: BrowsePage = {
  cards: [
    { id: "a", width: 100, height: 200, thumbnail: "L1/a/256", adult: false },
    { id: "b", width: 300, height: 100, thumbnail: "L1/b/256", adult: false },
  ],
  nextCursor: null,
  total: 2,
};
/** 安全模式关闭时多出一张含成人内容的图。 */
const released: BrowsePage = {
  cards: [...page.cards, { id: "x", width: 200, height: 200, thumbnail: "L1/x/256", adult: true }],
  nextCursor: null,
  total: 3,
};

const side: Sidebar = {
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
const detail = (id: string, manual: string | null): ImageDetail => ({
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

const label = (
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
const tags: Record<string, TagLabel> = {
  A: label("A", "artist", "某某"),
  C: label("C", "character", "某某"),
  B: label("B", "general", "蓝发"),
  Q: label("Q", "general", "水色发", true),
};
/** 模拟的近似对应表：蓝发～水色发（内置）。 */
const neighbours: Record<string, string[]> = { B: ["Q"], Q: ["B"] };
const candidates: Candidate[] = [
  { tag: tags.C, via: null, count: 8 },
  { tag: tags.A, via: null, count: 3 },
  { tag: tags.B, via: "某某色", count: 1 },
];

/** 模拟 Search：标签项照 id 填上标签名，文字项匹配名称含这段文字的标签；按 neighbours 近似展开。 */
function resolved(input: SearchInput): ConditionTree {
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
        const matched = Object.values(tags).filter((l) => l.name.includes(t.text));
        return {
          kind: "text" as const,
          text: t.text,
          tags: matched,
          similar: similar(
            matched.map((l) => l.id),
            t.dismissed,
          ),
        };
      }),
    })),
  };
}

type Call = { cmd: string; args: unknown };
/** 设置中的“显示相近标签来源”。 */
let showApproxSource = false;
let calls: Call[];
/** 后端的安全模式开关。 */
let safeOn = true;
/** 后端查不到的图（已删除或被封印）：查询返回 UnknownImage。 */
let gone = new Set<string>();

const clean: RecoveryReport = { interrupted: [], orphans: [], discardedStaging: 0 };

function backend(opened: LibraryInfo | null, recovery: RecoveryReport = clean,
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
        case "plugin:library|recovery":
          return recovery;
        case "plugin:library|search_candidates":
          return (args as { text: string }).text.trim() ? candidates : [];
        case "plugin:library|resolve_search":
          return resolved((args as { input: SearchInput }).input);
        case "tagging_status":
          return { libraryId: (args as { libraryId: string }).libraryId, status: { state: "starting" } };
        case "shell_settings":
          return { autostart: true, shortcuts: [], showApproxSource };
        default:
          return null;
      }
    }),
    { shouldMockEvents: true },
  );
}

/** Existing library-local approximation controls remain separate until global rules (T06) land. */
function LocalSearchFixture() {
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

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const push = (event: LibraryEvent) => act(() => emit("library-event", event));
const importAction = (name: string) => {
  if (!screen.queryByRole("button", { name })) fireEvent.click(screen.getByRole("button", { name: "导入参考图" }));
  const selector=screen.queryByRole("combobox",{name:"保存到资料库"}) as HTMLSelectElement|null;
  if(selector&&!selector.value&&Array.from(selector.options).some(o=>o.value==="L1"))fireEvent.change(selector,{target:{value:"L1"}});
  return screen.getByRole("button", { name });
};
async function confirmImport() {
  importAction("导入文件…");
  const button=await screen.findByRole("button",{name:/^开始(?: Eagle)? 导入$|^开始导入$/});
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
});

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  vi.unstubAllGlobals();
});

describe("主窗口", () => {
  it("查找头部显示真实结果数，图片大小滑块改变布局，导入操作按需展开", async () => {
    backend(library, clean, (command, args) => {
      if (command === "plugin:library|browse" && (args as { query: { scope: { kind: string } } }).query.scope.kind.startsWith("folder")) return { cards: [page.cards[0]], total: 1, nextCursor: null };
    });
    render(<App />);
    await screen.findAllByRole("img");
    const result = screen.getByRole("status", { name: "查找结果" });
    await waitFor(() => expect(result.textContent).toBe("2 张"));
    const card = screen.getByRole("listbox", { name: "图片墙" }).querySelector<HTMLElement>(".card")!;
    const before = parseFloat(card.style.width);
    const slider = screen.getByRole("slider", { name: "图片大小" });
    fireEvent.change(slider, { target: { value: "420" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(parseFloat(card.style.width)).toBeGreaterThan(before));
    expect(screen.queryByRole("button", { name: "导入文件夹…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "导入参考图" }));
    expect(importAction("导入文件夹…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "人物（1 张）" }));
    await waitFor(() => expect(result.textContent).toBe("1 张"));
  });

  it("尚未打开资料库时仍能从图标轨打开截图历史与钉剪贴板入口", async () => {
    backend(null);
    render(<App />);
    await screen.findByRole("button", { name: "建立资料库" });
    fireEvent.click(screen.getByRole("button", { name: "截图历史" }));
    expect(await screen.findByRole("region", { name: "截图历史" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "钉剪贴板" })).toBeTruthy();
  });

  it("查找区域的标签分组展开后可以添加、取消条件，并保留文件夹范围", async () => {
    backend(library, clean, (command) => command === "plugin:library|tag_groups" ? [{
      id: "G1", name: "发色", namespace: null, tags: [{ tag: tags.B, count: 1 }],
    }] : undefined);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "人物（1 张）" }));
    const bar = await screen.findByRole("toolbar", { name: "标签分组" });
    fireEvent.click(within(bar).getByRole("button", { name: "发色" }));
    fireEvent.click(within(bar).getByRole("button", { name: /蓝发/ }));
    expect(await screen.findByRole("list", { name: "查找条件" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("蓝发"));
    expect(screen.getByRole("button", { name: "人物（1 张）" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(bar).getByRole("button", { name: /蓝发/ }));
    await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toBe(""));
  });

  it("收起侧栏过程中按每次可用宽度连续重排，并保持阅读偏移", async () => {
    let available = 1000;
    const observers = new Set<() => void>();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => available });
    vi.stubGlobal("ResizeObserver", class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
      observe() {}
      disconnect() { observers.delete(this.callback); }
    });
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    wall.scrollTop = 60;
    fireEvent.scroll(wall);
    const offset = parseFloat(card.style.top) - wall.scrollTop;
    const initial = parseFloat(card.style.width);
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    available = 1100;
    act(() => observers.forEach((resize) => resize()));
    expect(parseFloat(card.style.width)).toBeGreaterThan(initial);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
    available = 1248;
    act(() => observers.forEach((resize) => resize()));
    expect(parseFloat(card.style.width)).toBeCloseTo(238.4);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
  });

  it("图标轨切换上下文侧栏时保留查找和图片墙，重复点按收起侧栏", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const groups = within(nav).getByRole("button", { name: "参考组" });
    fireEvent.click(groups);
    expect(await screen.findByRole("complementary", { name: "参考组" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "图片墙" })).toBe(wall);
    expect(screen.getByRole("combobox", { name: "查找参考图" })).toBeTruthy();
    fireEvent.click(groups);
    expect(groups.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(within(nav).getByRole("button", { name: "图片与文件夹" }));
    expect(screen.getByRole("complementary", { name: "文件夹" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建文件夹" })).toBeTruthy();
  });

  it("单击打开原图；Esc 返回原位置并把焦点交还参考图", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = document.querySelector<HTMLElement>(".wall")!;
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    wall.scrollTop = 120;
    fireEvent.scroll(wall);
    fireEvent.click(card);
    const viewer = await screen.findByRole("dialog", { name: "原图查看器" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/L1/a/full");
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(wall.scrollTop).toBe(120);
    expect(document.activeElement).toBe(card);

    fireEvent.keyDown(card, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "原图查看器" })).toBeTruthy();
  });

  it("开启安全模式时关闭查看器，回到图片墙", async () => {
    backend(library, clean, undefined, false);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.doubleClick(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await screen.findByRole("dialog", { name: "原图查看器" });
    await push({ kind: "safeModeChanged", libraryId: "L1", on: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("正在查看的图查不到（UnknownImage）时关闭查看器", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.doubleClick(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await screen.findByRole("dialog", { name: "原图查看器" });
    gone.add("a");
    await push({ kind: "listStale", libraryId: "L1" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("登记已有资料库后打开它，取消登记后可以继续建库或重新登记", async () => {
    backend(library);
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("当前资料库")).toHaveProperty("value", "L1"));
    window.__KINSHOKO_TEST_PICKS__ = ["E:\\私人收藏"];
    fireEvent.click(await screen.findByText("资料库操作"));
    fireEvent.click(screen.getByRole("button", { name: "登记已有资料库…" }));

    await waitFor(() => expect(screen.getByLabelText("当前资料库")).toHaveProperty("value", "L2"));
    expect(sent("plugin:library|register_library")).toEqual([{ root: "E:\\私人收藏" }]);
    fireEvent.click(await screen.findByRole("button", { name: "取消登记 私人收藏" }));
    await waitFor(() => expect(sent("plugin:library|unregister_library")).toEqual([{ libraryId: "L2" }]));
    expect(await screen.findByRole("button", { name: "建立资料库" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "登记已有资料库…" })).toBeTruthy();
  });

  it("切换时清空选择与导入状态，迟到的旧库浏览和进度不会覆盖新库", async () => {
    const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
    let resolveOld!: (page: BrowsePage) => void;
    const oldPage = new Promise<BrowsePage>((resolve) => { resolveOld = resolve; });
    let delayed = false;
    backend(library, clean, (cmd, args) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      if (cmd === "plugin:library|switch_library") return other;
      if (cmd === "plugin:library|browse") {
        if ((args as { libraryId: string }).libraryId === "L2") return { cards: [], nextCursor: null, total: 0 };
        if (delayed) return oldPage;
      }
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="a"]')!, { key: " " });
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 4 } });
    delayed = true;
    await push({ kind: "listStale", libraryId: "L1" });
    fireEvent.change(screen.getByLabelText("当前资料库"), { target: { value: "L2" } });
    await waitFor(() => expect(screen.getByLabelText("当前资料库")).toHaveProperty("value", "L2"));
    await act(() => resolveOld(page));
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 2, total: 4 } });
    await push({ kind: "taskFinished", libraryId: "L1", taskId: "T1", report: { cancelled: true, items: [], fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0, eagleRelocations: [] } });

    expect(await screen.findByText("资料库里还没有参考图。从上方导入图片或文件夹。")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/已选/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByLabelText("导入结果")).toBeNull();
    expect(sent("plugin:library|browse").at(-1)).toMatchObject({ libraryId: "L2" });
  });

  it.each(["进行中", "已结束"])("导入%s时打开新建资料库页再返回，保留结果和重试入口", async (stage) => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    window.__KINSHOKO_TEST_PICKS__ = ["D:\\参考"];
    fireEvent.click(importAction("导入文件夹…"));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 2 } });
    const finish = () => push({
      kind: "taskFinished",
      libraryId: "L1",
      taskId: "T1",
      report: {
        cancelled: false,
        fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0,
        eagleRelocations: [],
        items: [{ path: "D:\\参考\\坏.png", outcome: { kind: "readFailed", reason: "被占用" } }],
      },
    });
    if (stage === "已结束") await finish();

    fireEvent.click(screen.getByText("资料库操作"));
    fireEvent.click(screen.getByRole("button", { name: "新建资料库…" }));
    await screen.findByLabelText("资料库名称");
    // 等待页面切换的事件订阅清理，模拟导入在用户填写表单期间完成。
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    if (stage === "进行中") await finish();
    fireEvent.click(screen.getByRole("button", { name: "返回资料库" }));

    expect(await screen.findByText("D:\\参考\\坏.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toEqual([
      { libraryId: "L1", source: { paths: ["D:\\参考"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
      { libraryId: "L1", source: { paths: ["D:\\参考\\坏.png"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
    ]));
  });

  it.each([
    ["是搬了家，按原来源重导", { kind: "moved", sourceId: "S1" }],
    ["是另一个资料库，单独迁入", { kind: "separate" }],
  ])("Eagle 资料库疑似搬家时先问画师（%s），确认后再迁入", async (button, choice) => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    window.__KINSHOKO_TEST_PICKS__ = ["E:\\新\\主库.library"];
    fireEvent.click(importAction("导入文件夹…"));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await push({
      kind: "taskFinished",
      libraryId: "L1",
      taskId: "T1",
      report: {
        cancelled: false,
        items: [],
        fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0,
        eagleRelocations: [{ sourceId: "S1", from: "D:\\旧\\主库.library", to: "E:\\新\\主库.library", overlapPercent: 100 }],
      },
    });

    const prompt = await screen.findByRole("alert", { name: "Eagle 资料库换了位置？" });
    expect(within(prompt).getByText(/100% 的条目已经从另一个位置迁入过/)).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: button }));
    fireEvent.click(await screen.findByRole("button", { name: "开始 Eagle 导入" }));
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(2));
    expect(sent("plugin:library|confirm_eagle_location")).toEqual([
      { libraryId: "L1", path: "E:\\新\\主库.library", choice },
    ]);
    expect(sent("plugin:library|start_import").at(-1)).toEqual({
      libraryId: "L1",
      source: { paths: ["E:\\新\\主库.library"] },
      options: { eagleDeletedContent: "skipDeleted" },
      destination:{libraryId:"L1",folderId:null},
    });
    expect(screen.queryByRole("alert", { name: "Eagle 资料库换了位置？" })).toBeNull();
  });

  it("新建资料库页不接受拖放导入，返回当前库后恢复拖放", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    importAction("导入文件…");
    const position = { x: 10, y: 10 };
    const paths = ["D:\\参考\\a.png"];
    await act(() => emit("tauri://drag-enter", { paths, position }));
    expect(screen.getByText("松开即可导入到 工作参考")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建资料库…" }));
    await screen.findByLabelText("资料库名称");
    await act(() => emit("tauri://drag-drop", { paths, position }));
    expect(sent("plugin:library|start_import")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "返回资料库" }));
    expect(screen.queryByText("松开即可导入到 工作参考")).toBeNull();
    await act(() => emit("tauri://drag-drop", { paths, position }));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toEqual([
      { libraryId: "L1", source: { paths }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
    ]));
  });

  it("选择导入文件的对话框等待期间切换库，迟到的选择不会导入新库", async () => {
    const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
    let resolvePick!: (paths: string[]) => void;
    const picked = new Promise<string[]>((resolve) => { resolvePick = resolve; });
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      if (cmd === "plugin:library|switch_library") return other;
      if (cmd === "plugin:library|pick_files") return picked;
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(importAction("导入文件…"));
    await waitFor(() => expect(sent("plugin:library|pick_files").length).toBe(1));
    fireEvent.change(screen.getByLabelText("当前资料库"), { target: { value: "L2" } });
    await waitFor(() => expect(screen.getByLabelText("当前资料库")).toHaveProperty("value", "L2"));
    await act(() => resolvePick(["D:\\参考.png"]));
    expect(sent("plugin:library|start_import")).toEqual([]);
  });

  it("不可用的资料库显示原因，切换失败时仍能浏览当前库", async () => {
    const other = { id: "L2", name: "移动盘参考", root: "E:\\移动盘参考" };
    const reason = "资料库暂时不可用：E:\\移动盘参考。请确认移动盘已连接，搬家后重新登记。";
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [
        { library, unavailable: null }, { library: other, unavailable: reason },
      ];
      if (cmd === "plugin:library|switch_library") return Promise.reject(reason);
      return undefined;
    });
    render(<App />);
    expect(await screen.findByRole("option", { name: "移动盘参考（暂时不可用）" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("当前资料库"), { target: { value: "L2" } });
    expect((await screen.findByRole("alert")).textContent).toContain("移动盘已连接");
    expect(screen.getByLabelText("当前资料库")).toHaveProperty("value", "L1");
    expect(screen.getByRole("button", { name: "登记已有资料库…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消登记 移动盘参考" })).toBeTruthy();
  });

  it("在状态栏显示核心报告的版本", async () => {
    backend(library);
    render(<App />);
    expect(await screen.findByText("Kinshoko 9.9.9")).toBeTruthy();
  });

  it("没有资料库时引导建库：选择存放位置后在那里新建并打开", async () => {
    backend(null);
    render(<App />);

    fireEvent.change(await screen.findByLabelText("资料库名称"), {
      target: { value: "工作参考" },
    });
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\参考"];
    fireEvent.click(screen.getByRole("button", { name: "选择存放位置…" }));
    expect(await screen.findByText("D:\\参考")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "建立资料库" }));

    await waitFor(() => expect(screen.getByLabelText("当前资料库")).toHaveProperty("value", "L1"));
    expect(sent("plugin:library|create_library")).toEqual([
      { parent: "D:\\参考", name: "工作参考" },
    ]);
  });

  it("打开的资料库在图片墙上按资料库记录的比例显示缩略图", async () => {
    backend(library);
    render(<App />);

    const images = await screen.findAllByRole("img");
    expect(images.map((i) => i.getAttribute("src"))).toEqual([
      "http://thumb.localhost/L1/a/256",
      "http://thumb.localhost/L1/b/256",
    ]);
    const box = (el: HTMLElement) => el.closest<HTMLElement>("[data-id]")!.style;
    const ratio = (s: CSSStyleDeclaration) => parseFloat(s.height) / parseFloat(s.width);
    expect(ratio(box(images[0]))).toBeCloseTo(2, 3);
    expect(ratio(box(images[1]))).toBeCloseTo(1 / 3, 3);
  });

  it("导入文件夹时显示进度、可以取消，结束后逐项列出没有进来的文件", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    window.__KINSHOKO_TEST_PICKS__ = ["D:\\下载\\参考"];
    fireEvent.click(importAction("导入文件夹…"));
    await confirmImport();
    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
      { libraryId: "L1", source: { paths: ["D:\\下载\\参考"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
      ]),
    );

    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 4 } });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByText("正在导入 1 / 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消导入" }));
    await waitFor(() => expect(sent("plugin:library|cancel_import")).toEqual([{ libraryId: "L1", taskId: "T1" }]));

    const browsed = sent("plugin:library|browse").length;
    await push({ kind: "listStale", libraryId: "L1" });
    await waitFor(() => expect(sent("plugin:library|browse").length).toBeGreaterThan(browsed));

    await push({
      kind: "taskFinished",
      libraryId: "L1",
      taskId: "T1",
      report: {
        cancelled: true,
        fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0,
        eagleRelocations: [],
        items: [
          { path: "D:\\下载\\参考\\a.png", outcome: { kind: "imported", imageId: "a" } },
          { path: "D:\\下载\\参考\\说明.txt", outcome: { kind: "unsupported" } },
          { path: "D:\\下载\\参考\\坏.png", outcome: { kind: "readFailed", reason: "无法解码" } },
        ],
      },
    });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/已取消/)).toBeTruthy();
    expect(screen.getByText("D:\\下载\\参考\\说明.txt")).toBeTruthy();
    expect(screen.getByText("不支持的格式")).toBeTruthy();
    expect(screen.getByText("读取失败：无法解码")).toBeTruthy();
  });

  it("把图片和文件夹拖进主窗口就开始导入", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    importAction("导入文件…");
    const position = { x: 10, y: 10 };
    await act(() =>
      emit("tauri://drag-enter", { paths: ["D:\\图\\a.png", "D:\\一批参考"], position }),
    );
    expect(screen.getByText("松开即可导入到 工作参考")).toBeTruthy();
    await act(() => emit("tauri://drag-drop", { paths: ["D:\\图\\a.png", "D:\\一批参考"], position }));
    await confirmImport();

    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { libraryId: "L1", source: { paths: ["D:\\图\\a.png", "D:\\一批参考"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
      ]),
    );
    expect(screen.queryByText("松开即可导入到 工作参考")).toBeNull();
  });

  it("导入结束后可以只重试读取失败的项", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    await push({
      kind: "taskFinished",
      libraryId: "L1",
      taskId: "T0",
      report: {
        cancelled: false,
        fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0,
        eagleRelocations: [],
        items: [
          { path: "D:\\参考\\a.png", outcome: { kind: "imported", imageId: "a" } },
          { path: "D:\\参考\\说明.txt", outcome: { kind: "unsupported" } },
          { path: "D:\\参考\\坏.png", outcome: { kind: "readFailed", reason: "被占用" } },
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));
    await confirmImport();

    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { libraryId: "L1", source: { paths: ["D:\\参考\\坏.png"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
      ]),
    );
  });

  it("上次导入中断时提示撤回了哪些文件，并可以重新导入", async () => {
    backend(library, {
      interrupted: ["D:\\参考\\b.png"],
      orphans: ["originals/ab/x.png"],
      discardedStaging: 0,
    });
    render(<App />);

    const notice = await screen.findByRole("status", { name: "上次导入中断" });
    expect(notice.textContent).toContain("D:\\参考\\b.png");
    expect(notice.textContent).toContain("1 个不认识的文件");
    fireEvent.click(screen.getByRole("button", { name: "重新导入这些文件" }));
    await confirmImport();

    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { libraryId: "L1", source: { paths: ["D:\\参考\\b.png"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
      ]),
    );
  });

  it("从状态栏打开设置", async () => {
    mockIPC(workspaceFixture((cmd) => {
      if (cmd === "app_info") return { productName: "Kinshoko", version: "9.9.9" };
      if (cmd === "shell_settings") return { autostart: true, shortcuts: [] };
      return undefined;
    }), { shouldMockEvents: true });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("region", { name: "设置" })).toBeTruthy();
  });
});

describe("导入任务的终态（#76）", () => {
  const importButton = () => importAction("导入文件…") as HTMLButtonElement;
  const failed = (taskId: string) => push({
    kind: "taskFinished",
    libraryId: "L1",
    taskId,
    report: {
      cancelled: false,
      items: [{ path: "D:\\参考\\坏.png", outcome: { kind: "readFailed", reason: "被占用" } }],
      fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0,
      eagleRelocations: [],
    },
  });

  it("结束事件早于启动命令的响应时，迟到的响应和进度不会复活已结束的任务", async () => {
    let answer!: (taskId: string) => void;
    const response = new Promise<string>((resolve) => { answer = resolve; });
    backend(library, clean, (cmd) => (cmd === "plugin:library|start_import" ? response : undefined));
    render(<App />);
    await screen.findAllByRole("img");
    window.__KINSHOKO_TEST_PICKS__ = [["D:\\参考\\坏.png"]];
    fireEvent.click(importButton());
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 1 } });
    await failed("T1");
    await act(async () => {
      answer("T1");
      await response;
    });
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 1 } });

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/导入完成/)).toBeTruthy();
    expect(screen.getByText("读取失败：被占用")).toBeTruthy();
    expect(importButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(2));
  });

  it("进度早于启动命令的响应时，响应到达后仍可取消", async () => {
    let answer!: (taskId: string) => void;
    const response = new Promise<string>((resolve) => { answer = resolve; });
    backend(library, clean, (cmd) => (cmd === "plugin:library|start_import" ? response : undefined));
    render(<App />);
    await screen.findAllByRole("img");
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\参考"];
    fireEvent.click(importAction("导入文件夹…"));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 3 } });
    await act(async () => {
      answer("T1");
      await response;
    });

    expect(screen.getByText("正在导入 1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消导入" }));
    await waitFor(() => expect(sent("plugin:library|cancel_import")).toEqual([{ libraryId: "L1", taskId: "T1" }]));
  });

  it("旧任务与别的资料库的迟到事件不会覆盖新任务", async () => {
    let next = 0;
    backend(library, clean, (cmd) => (cmd === "plugin:library|start_import" ? `T${++next}` : undefined));
    render(<App />);
    await screen.findAllByRole("img");
    window.__KINSHOKO_TEST_PICKS__ = [["D:\\参考\\坏.png"]];
    fireEvent.click(importButton());
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await failed("T1");
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(2));
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T2", progress: { done: 1, total: 5 } });

    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 1 } });
    await failed("T1");
    await push({ kind: "taskFinished", libraryId: "L2", taskId: "T2", report: { cancelled: true, items: [], fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0, eagleRelocations: [] } });

    expect(screen.getByText("正在导入 1 / 5")).toBeTruthy();
    expect(screen.queryByLabelText("导入结果")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消导入" }));
    await waitFor(() => expect(sent("plugin:library|cancel_import")).toEqual([{ libraryId: "L1", taskId: "T2" }]));
  });
});

describe("Eagle 迁入完成后的标签外部对应（#77 UI-E）", () => {
  const step = () => screen.queryByRole("region", { name: "标签的外部对应" });
  const finished = (taskId: string, fromEagle = false) => push({
    kind: "taskFinished",
    libraryId: "L1",
    taskId,
    report: { cancelled: false, items: [], fromEagle, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0, eagleRelocations: [] },
  });
  /** 启动命令的响应由测试放出；`fail` 让下一次启动出错。 */
  function eagleBackend() {
    const answers: ((taskId: string) => void)[] = [];
    const failures: string[] = [];
    backend(library, clean, (cmd) => {
      switch (cmd) {
        case "plugin:library|discover_eagle_libraries":
          return [{ name: "主库", path: "D:/Eagle/主库.library", items: 3, version: "4.0.0", foundBy: "settings" }];
        case "plugin:library|eagle_tag_mapping":
          return { matched: [], unmatched: [], vocabularySize: 0 };
        case "plugin:library|start_import": {
          const failure = failures.shift();
          if (failure) return Promise.reject(failure);
          return new Promise<string>((resolve) => answers.push(resolve));
        }
        default:
          return undefined;
      }
    });
    const answer = (taskId: string) =>
      act(async () => {
        answers.shift()!(taskId);
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
    return { answer, fail: (reason: string) => failures.push(reason) };
  }
  async function startEagle() {
    fireEvent.click(importAction("从 Eagle 迁入…"));
    fireEvent.click(await screen.findByRole("button", { name: "迁入 主库" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始 Eagle 导入" }));
  }
  async function startFiles(count: number) {
    window.__KINSHOKO_TEST_PICKS__ = [["D:\\参考\\a.png"]];
    fireEvent.click(importAction("导入文件…"));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(count));
  }

  it.each(["文件夹", "拖放"])("从通用%s入口识别到 Eagle，结束事件先到也只打开一次标签步骤", async (entrance) => {
    const { answer } = eagleBackend();
    render(<App />);
    await screen.findAllByRole("img");
    const paths = ["D:/Eagle/主库.library"];
    if (entrance === "文件夹") {
      window.__KINSHOKO_TEST_PICKS__ = paths;
      fireEvent.click(importAction("导入文件夹…"));
    await confirmImport();
    } else {
      importAction("导入文件…");
      await act(() => emit("tauri://drag-drop", { paths, position: { x: 10, y: 10 } }));
      await confirmImport();
    }
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await finished("T1", true);
    await answer("T1");
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await finished("T1", true);
    expect(step()).toBeNull();
  });

  it("结束事件早于启动命令的响应时，仍保留报告并打开一次这一步", async () => {
    const { answer } = eagleBackend();
    render(<App />);
    await screen.findAllByRole("img");
    await startEagle();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await finished("T1");
    await answer("T1");

    expect(screen.getByRole("region", { name: "导入结果" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(step()).toBeNull();
    // 之后的重新渲染不再打开。
    await push({ kind: "listStale", libraryId: "L1" });
    await finished("T1");
    expect(step()).toBeNull();
  });

  it("对照：启动命令的响应先到时同样打开一次", async () => {
    const { answer } = eagleBackend();
    render(<App />);
    await screen.findAllByRole("img");
    await startEagle();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await answer("T1");
    expect(step()).toBeNull();
    await finished("T1");
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
  });

  it("普通文件导入在两种顺序下都不打开这一步", async () => {
    const { answer } = eagleBackend();
    render(<App />);
    await screen.findAllByRole("img");
    await startFiles(1);
    await finished("T1");
    await answer("T1");
    await screen.findByRole("region", { name: "导入结果" });
    expect(step()).toBeNull();

    await startFiles(2);
    await answer("T2");
    await finished("T2");
    await screen.findByRole("region", { name: "导入结果" });
    expect(step()).toBeNull();
  });

  it("Eagle 迁入与紧接着的普通导入不串结果；启动出错后可以重来", async () => {
    const { answer, fail } = eagleBackend();
    render(<App />);
    await screen.findAllByRole("img");
    await startEagle();
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(1));
    await answer("T1");
    await finished("T1");
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await startFiles(2);
    await finished("T2");
    await answer("T2");
    await screen.findByRole("region", { name: "导入结果" });
    expect(step()).toBeNull();

    // 启动出错：显示错误，不打开这一步；再迁入一次照常。
    fail("资料库正忙");
    await startEagle();
    expect(await screen.findByText("无法开始导入：资料库正忙")).toBeTruthy();
    expect(step()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始 Eagle 导入" }));
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(4));
    await finished("T3");
    await answer("T3");
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
  });
});

describe("整理", () => {
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

  it("侧栏列出全部、文件夹树与回收站及其计数，点文件夹按文件夹浏览", async () => {
    backend(library);
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: /工作参考.*的目录/ });
    await waitFor(() => expect(nav.textContent).toContain("发型"));
    expect(screen.getByRole("button", { name: "工作参考（2 张）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "人物（1 张）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "回收站（1 张）" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "发型（0 张）" }));
    await waitFor(() =>
      expect(sent("plugin:library|browse").at(-1)).toMatchObject({
        query: { scope: { kind: "folderTree", id: "F2" } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "回收站（1 张）" }));
    await waitFor(() =>
      expect(sent("plugin:library|browse").at(-1)).toMatchObject({
        query: { scope: { kind: "trash" } },
      }),
    );
  });

  it("新建文件夹放在当前打开的文件夹里，双击改名", async () => {
    backend(library);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "人物（1 张）" }));
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    const input = screen.getByLabelText("新文件夹名称");
    fireEvent.change(input, { target: { value: "姿势" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(sent("plugin:library|create_folder")).toEqual([{ libraryId: "L1", name: "姿势", parent: "F1" }]),
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "发型（0 张）" }));
    const rename = screen.getByLabelText("文件夹名称");
    fireEvent.change(rename, { target: { value: "发型与刘海" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() =>
      expect(sent("plugin:library|rename_folder")).toEqual([{ libraryId: "L1", folderId: "F2", name: "发型与刘海" }]),
    );
  });

  it("选中多张图后批量放入文件夹、删除；回收站里恢复", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(card("b"), { ctrlKey: true });
    expect(screen.getByText("已选 2 张")).toBeTruthy();

    await waitFor(() => expect(within(screen.getByLabelText("放入文件夹")).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("放入文件夹"), { target: { value: "F2" } });
    await waitFor(() =>
      expect(sent("plugin:library|edit")).toEqual([
        { libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "addToFolder", folderId: "F2" }] },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "delete" }] }),
    );
    await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "回收站（1 张）" }));
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ libraryId: "L1", ids: ["a"], edits: [{ kind: "restore" }] }),
    );
  });

  it("回收站里永久删除：先列出受影响的参考组，过期时重新预览后再确认", async () => {
    let previews = 0;
    let stale = true;
    backend(library, clean, (cmd, args) => {
      if (cmd === "plugin:library|preview_permanent_delete") {
        previews += 1;
        const { ids } = args as { ids: string[] };
        return {
          imageIds: ids,
          groups: previews === 1 ? [] : [{ groupId: "G1", name: "手的参考", imageIds: ids }],
          token: `T${previews}`,
        };
      }
      if (cmd === "plugin:library|permanent_delete") {
        if (stale) {
          stale = false;
          return Promise.reject("回收站或参考组在确认前有变化，请重新查看将受影响的参考组");
        }
        return null;
      }
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "回收站（1 张）" }));
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(await screen.findByRole("button", { name: "永久删除…" }));

    // 没有受影响的参考组：直接确认。
    expect(await screen.findByText(/永久删除这 1 张图/)).toBeTruthy();
    expect(screen.queryByLabelText("受影响的参考组")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));

    // 预览之后有参考组用上了这张图：被拒绝，重新列出后再确认。
    const list = await screen.findByLabelText("受影响的参考组");
    expect(within(list).getByText("手的参考（1 张）")).toBeTruthy();
    expect(screen.getByText(/刚有变化/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
    await waitFor(() =>
      expect(sent("plugin:library|permanent_delete")).toEqual([
        { libraryId: "L1", ids: ["a"], token: "T1" },
        { libraryId: "L1", ids: ["a"], token: "T2" },
      ]),
    );
    await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());
  });

  it("只选一张时写备注，并能退回来源的备注", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("a"), { key: " " });
    expect(await screen.findByText("所在文件夹：人物")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "看左手" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({
        libraryId: "L1",
        ids: ["a"],
        edits: [{ kind: "setNote", text: "看左手" }],
      }),
    );
    const revert = screen.getByRole("button", { name: "退回来源备注" });
    await waitFor(() => expect((revert as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(revert);
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ libraryId: "L1", ids: ["a"], edits: [{ kind: "revertNote" }] }),
    );
  });
});

describe("查找", () => {
  const box = () => screen.findByRole("combobox", { name: "查找参考图" });
  const lastInput = () => (sent("plugin:library|resolve_search").at(-1) as { input: SearchInput }).input;
  const lastQuery = () =>
    (sent("plugin:library|browse").at(-1) as { query: { conditions: ConditionTree } }).query;

  it("切换整理资料库保留全局条件，旧候选和旧条件树按代次重新解析", async () => {
    const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
    let finishCandidates!: (value: Candidate[]) => void;
    let finishTree!: (value: ConditionTree) => void;
    const oldCandidates = new Promise<Candidate[]>((resolve) => { finishCandidates = resolve; });
    const oldTree = new Promise<ConditionTree>((resolve) => { finishTree = resolve; });
    let requests = 0;
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      if (cmd === "plugin:library|switch_library") return other;
      if (cmd === "plugin:library|resolve_search") return oldTree;
      if (cmd === "plugin:library|search_candidates") return requests++ === 0 ? oldCandidates : [];
      return undefined;
    });
    render(<App />);
    const input = await box();
    fireEvent.change(input, { target: { value: "某" } });
    await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sent("plugin:library|resolve_search")).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("当前资料库"), { target: { value: "L2" } });
    await waitFor(() => expect(screen.getByLabelText("当前资料库")).toHaveProperty("value", "L2"));
    fireEvent.change(await box(), { target: { value: "某" } });
    await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(2));
    await act(() => {
      finishCandidates(candidates);
      finishTree(resolved({ conditions: [{ any: [{ kind: "text", text: "旧库条件", dismissed: [] }], negate: false }], exact: false }));
    });

    expect(within(screen.getByRole("listbox", { name: "" })).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("list", { name: "查找条件" }).children).toHaveLength(1);
    expect(lastQuery().conditions.conditions).toHaveLength(1);
    expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ libraryId: "L2" });
    expect(sent("plugin:library|resolve_search")[0]).toMatchObject({ libraryId: "L1" });
  });

  it("输入的词命中多个命名空间与别名时，下拉按命名空间与别名列出候选", async () => {
    backend(library);
    render(<App />);
    fireEvent.change(await box(), { target: { value: "某某" } });

    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "" })).getAllByRole("option")).toHaveLength(4));
    expect(within(screen.getByRole("listbox", { name: "" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "查找“某某”",
      "角色：某某8",
      "作者：某某3",
      "蓝发又名：某某色1",
    ]);
    expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ text: "某某", lang: "zh-CN" });
  });

  it("不选候选直接回车就按文字查找，点选候选只查这个标签；图片墙按条件树重新浏览", async () => {
    backend(library);
    render(<App />);
    const input = await box();
    fireEvent.change(input, { target: { value: "某某" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(lastInput()).toEqual({
        conditions: [{ any: [{ kind: "text", text: "某某", dismissed: [] }], negate: false }],
        exact: false,
      }),
    );
    await waitFor(() => expect(lastQuery().conditions).toEqual(resolved(lastInput())));
    const chips = screen.getByRole("list", { name: "查找条件" });
    expect(chips.textContent).toContain("“某某”");
    expect((input as HTMLInputElement).value).toBe("");

    fireEvent.change(input, { target: { value: "某" } });
    fireEvent.click(await screen.findByRole("option", { name: /作者：某某/ }));
    await waitFor(() => expect(lastInput().conditions).toHaveLength(2));
    expect(lastInput().conditions[1]).toEqual({ any: [{ kind: "tag", id: "A", dismissed: [] }], negate: false });
    await waitFor(() => expect(lastQuery().conditions.conditions).toHaveLength(2));
    expect(chips.textContent).toContain("作者：某某");
  });

  it("Alt+回车或 Ctrl 点选把候选加进上一个条件作为“任一”；可以排除或去掉条件", async () => {
    backend(library);
    render(<App />);
    const input = await box();
    fireEvent.change(input, { target: { value: "蓝" } });
    fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
    await waitFor(() => expect(lastInput().conditions).toHaveLength(1));

    fireEvent.change(input, { target: { value: "某" } });
    fireEvent.click(await screen.findByRole("option", { name: /角色：某某/ }), { ctrlKey: true });
    await waitFor(() =>
      expect(lastInput().conditions).toEqual([
        {
          any: [
            { kind: "tag", id: "B", dismissed: [] },
            { kind: "tag", id: "C", dismissed: [] },
          ],
          negate: false,
        },
      ]),
    );
    fireEvent.change(input, { target: { value: "紫发" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    await waitFor(() => expect(lastInput().conditions[0].any).toHaveLength(3));
    expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("或");

    fireEvent.click(screen.getByRole("button", { name: "排除这个条件" }));
    await waitFor(() => expect(lastInput().conditions[0].negate).toBe(true));
    expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("不要");

    fireEvent.click(screen.getByRole("button", { name: "去掉这个条件" }));
    await waitFor(() => expect(lastQuery().conditions).toEqual({ conditions: [] }));
  });
});

describe("近似查找", () => {
  const box = () => screen.findByRole("combobox", { name: "查找参考图" });
  const chips = () => screen.getByRole("list", { name: "查找条件" });
  const lastInput = () => (sent("plugin:library|resolve_search").at(-1) as { input: SearchInput }).input;

  /** 点选“蓝发”作为一个条件。 */
  async function pickBlue() {
    const input = await box();
    fireEvent.change(input, { target: { value: "蓝" } });
    fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
    await waitFor(() => expect(chips().textContent).toContain("水色发"));
  }

  it("默认在条件里列出展开的相近标签，一键改回精确查找", async () => {
    backend(library);
    render(<App />);
    await pickBlue();
    expect(chips().textContent).toContain("蓝发或相近：水色发");
    expect(chips().textContent).not.toContain("内置");

    fireEvent.click(screen.getByRole("button", { name: "精确查找", pressed: false }));

    await waitFor(() => expect(lastInput().exact).toBe(true));
    await waitFor(() => expect(chips().textContent).not.toContain("水色发"));
    expect(screen.getByRole("button", { name: "精确查找", pressed: true })).toBeTruthy();
  });

  it("关掉一个相近标签时，“只这次”只改本次条件，“以后都不展开”记进个人近似对应表", async () => {
    backend(library);
    render(<LocalSearchFixture />);
    await pickBlue();

    fireEvent.click(screen.getByRole("button", { name: "不展开“水色发”" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "不展开相近标签" })).getByRole("button", { name: "只这次" }));
    await waitFor(() =>
      expect(lastInput().conditions[0].any[0]).toEqual({ kind: "tag", id: "B", dismissed: ["Q"] }),
    );
    await waitFor(() => expect(chips().textContent).not.toContain("水色发"));
    expect(sent("plugin:library|set_tag_approx")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "去掉这个条件" }));
    await pickBlue();
    fireEvent.click(screen.getByRole("button", { name: "不展开“水色发”" }));
    fireEvent.click(screen.getByRole("button", { name: "以后都不展开" }));
    await waitFor(() =>
      expect(sent("plugin:library|set_tag_approx")).toEqual([{ libraryId: "L1", a: "B", b: "Q", relation: "notSimilar" }]),
    );
    expect(screen.queryByRole("dialog", { name: "不展开相近标签" })).toBeNull();
  });

  it("用“＋”从库内标签里挑一个加为相近标签", async () => {
    backend(library);
    render(<LocalSearchFixture />);
    await pickBlue();

    fireEvent.click(screen.getByRole("button", { name: "给“蓝发”加相近标签" }));
    const dialog = screen.getByRole("dialog", { name: "加相近标签" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "挑一个库内标签" }), {
      target: { value: "某" },
    });
    fireEvent.click(await within(dialog).findByRole("option", { name: /作者：某某/ }));

    await waitFor(() =>
      expect(sent("plugin:library|set_tag_approx")).toEqual([{ libraryId: "L1", a: "B", b: "A", relation: "similar" }]),
    );
    expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
  });

  it("设置中开启来源标记后，相近标签旁标出来自内置还是个人近似对应表", async () => {
    showApproxSource = true;
    backend(library);
    render(<App />);
    await pickBlue();

    await waitFor(() => expect(chips().textContent).toContain("水色发内置"));
  });

  it("没有外部对应的标签旁显示提示图标，有外部对应的不显示", async () => {
    backend(library);
    render(<App />);
    await pickBlue();

    const hints = within(chips()).getAllByRole("img", { name: "没有外部对应，不参与内置近似对应表" });
    expect(hints).toHaveLength(1);
    expect(hints[0].previousElementSibling?.textContent).toBe("蓝发");
  });
});

describe("安全模式", () => {
  const book = () => screen.findByRole("button", { name: /安全模式/ });
  const cardOf = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  const changed = (on: boolean) => push({ kind: "safeModeChanged", libraryId: "L1", on });

  it("新装默认开启；点封印书或按 Ctrl+Shift+S 切换", async () => {
    backend(library);
    render(<App />);
    const button = await book();
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(sent("plugin:library|set_safe_mode")).toEqual([{ on: false }]));

    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(sent("plugin:library|set_safe_mode")).toEqual([{ on: false }, { on: true }]),
    );
  });

  it("开启的同一刻遮住将被封印的图，资料库确认后它们离开图片墙", async () => {
    backend(library, clean, undefined, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")?.dataset.veiled).toBe("false"));
    expect(cardOf("a")?.dataset.veiled).toBe("false");

    fireEvent.click(await book());
    // 不等后端：点下的这一帧就开始遮蔽。
    expect(cardOf("x") === null || cardOf("x")?.dataset.veiled === "true").toBe(true);
    expect(cardOf("a") === null || cardOf("a")?.dataset.veiled === "false").toBe(true);

    await changed(true);
    await waitFor(() => expect(cardOf("x")).toBeNull());
    expect(cardOf("a")).toBeTruthy();
  });

  it("关闭后被封印的图回到图片墙；释放未播完时再开启，立即重新遮住", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    expect(cardOf("x")).toBeNull();

    fireEvent.click(await book());
    await changed(false);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    await waitFor(() => expect(cardOf("x")?.dataset.veiled).toBe("false"));

    fireEvent.click(await book());
    expect(cardOf("x") === null || cardOf("x")?.dataset.veiled === "true").toBe(true);
  });

  it("开启后清掉选中的图，侧栏计数随之刷新", async () => {
    backend(library, clean, undefined, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    fireEvent.keyDown(cardOf("x")!, { key: " " });
    expect(screen.getByText("已选 1 张")).toBeTruthy();
    const sidebars = sent("plugin:library|sidebar").length;

    fireEvent.click(await book());
    await changed(true);
    await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());
    await waitFor(() => expect(sent("plugin:library|sidebar").length).toBeGreaterThan(sidebars));
  });
  describe("候选随视角作废（#76）", () => {
    const adult: Candidate = { tag: label("ADULT", "general", "只在成人图出现的标签"), via: null, count: 1 };
    const box = () => screen.findByRole("combobox", { name: "查找参考图" });
    /** 后端核对请求带的视角：与资料库的安全模式不同时拒绝，与真实命令一致。 */
    const lensChecked = (hold?: () => Promise<Candidate[]> | undefined) => (cmd: string, args: unknown) => {
      if (cmd !== "plugin:library|search_candidates") return undefined;
      const { text, safeMode } = args as { text: string; safeMode: boolean };
      const held = hold?.();
      if (held) return held;
      if (safeMode !== safeOn) return Promise.reject("安全模式刚切换过，请重新查找");
      return text.trim() && !safeOn ? [adult] : [];
    };

    it.each(["封印书", "快捷键"])("用%s开启安全模式时立即清掉成人图独有的候选与数量，重新聚焦也不再出现", async (entry) => {
      backend(library, clean, lensChecked(), false);
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      expect(await screen.findByText("只在成人图出现的标签")).toBeTruthy();

      if (entry === "封印书") fireEvent.click(await book());
      else fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      // 不等后端确认，也不用再打字。
      expect(screen.queryByText("只在成人图出现的标签")).toBeNull();
      expect(document.querySelector(".search-candidate-count")).toBeNull();

      await changed(true);
      fireEvent.blur(input);
      fireEvent.focus(input);
      await waitFor(() =>
        expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ text: "只在成人", safeMode: true }),
      );
      expect(screen.queryByText("只在成人图出现的标签")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("切换前发出的候选请求迟到时不写回新视角", async () => {
      let finish!: (value: Candidate[]) => void;
      const late = new Promise<Candidate[]>((resolve) => { finish = resolve; });
      let first = true;
      backend(library, clean, lensChecked(() => {
        if (!first) return undefined;
        first = false;
        return late;
      }), false);
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(1));
      fireEvent.click(await book());
      await changed(true);
      await act(async () => {
        finish([adult]);
        await late;
      });
      expect(screen.queryByText("只在成人图出现的标签")).toBeNull();
    });

    it("关闭后候选按新视角重新取得，再开启时又立即清掉", async () => {
      backend(library, clean, lensChecked());
      render(<App />);
      await screen.findAllByRole("img");
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(1));
      expect(screen.queryByText("只在成人图出现的标签")).toBeNull();

      fireEvent.click(await book());
      await changed(false);
      expect(await screen.findByText("只在成人图出现的标签")).toBeTruthy();

      fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
      expect(screen.queryByText("只在成人图出现的标签")).toBeNull();
    });

    it("词表变化后重新取得候选", async () => {
      let names = ["旧名"];
      backend(library, clean, (cmd) =>
        cmd === "plugin:library|search_candidates"
          ? names.map((name) => ({ tag: label(name, "general", name), via: null, count: 1 }))
          : undefined,
      );
      render(<App />);
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "名" } });
      expect(await screen.findByText("旧名")).toBeTruthy();
      names = ["新名"];
      await push({ kind: "vocabularyChanged", libraryId: "L1", revision: 9 });
      expect(await screen.findByText("新名")).toBeTruthy();
      expect(screen.queryByText("旧名")).toBeNull();
    });

    it("“加相近标签”的候选同样随视角作废，迟到的响应不写回", async () => {
      let finish!: (value: Candidate[]) => void;
      const late = new Promise<Candidate[]>((resolve) => { finish = resolve; });
      let holding = false;
      backend(library, clean, (cmd, args) => {
        if (cmd !== "plugin:library|search_candidates") return undefined;
        const { text, safeMode } = args as { text: string; safeMode: boolean };
        if (text === "只在成人" && holding) {
          holding = false;
          return late;
        }
        if (safeMode !== safeOn) return Promise.reject("安全模式刚切换过，请重新查找");
        if (text === "只在成人") return safeOn ? [] : [adult];
        return text.trim() ? candidates : [];
      }, false);
      render(<LocalSearchFixture />);
      const input = await box();
      fireEvent.change(input, { target: { value: "蓝" } });
      fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      const dialog = screen.getByRole("dialog", { name: "加相近标签" });
      const pick = within(dialog).getByRole("combobox", { name: "挑一个库内标签" });
      fireEvent.change(pick, { target: { value: "只在成人" } });
      expect(await within(dialog).findByText("只在成人图出现的标签")).toBeTruthy();

      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
      await changed(true);
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      const safeDialog = screen.getByRole("dialog", { name: "加相近标签" });
      fireEvent.change(within(safeDialog).getByRole("combobox"), { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ text: "只在成人", safeMode: true }));
      expect(within(safeDialog).queryByText("只在成人图出现的标签")).toBeNull();

      // An unsafe request may finish after its dialog and lens have been revoked.
      holding = true;
      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      await changed(false);
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      fireEvent.change(within(screen.getByRole("dialog", { name: "加相近标签" })).getByRole("combobox"), { target: { value: "只在成人" } });
      await waitFor(() => expect(holding).toBe(false));
      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      await changed(true);
      await act(async () => { finish([adult]); await late; });
      expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
      expect(screen.queryByText("只在成人图出现的标签")).toBeNull();
    });

    it("条件解析带上当前视角，视角刚切换的拒绝不当作错误显示", async () => {
      backend(library, clean, (cmd, args) => {
        if (cmd !== "plugin:library|resolve_search") return undefined;
        const { input, safeMode } = args as { input: SearchInput; safeMode: boolean };
        if (safeMode !== safeOn) return Promise.reject("安全模式刚切换过，请重新查找");
        return resolved(input);
      }, false);
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.change(input, { target: { value: "蓝" } });
      fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
      await waitFor(() => expect(sent("plugin:library|resolve_search").at(-1)).toMatchObject({ safeMode: false }));
      fireEvent.click(await book());
      await waitFor(() => expect(sent("plugin:library|resolve_search").at(-1)).toMatchObject({ safeMode: true }));
      await changed(true);
      await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("水色发"));
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});

describe("聚合来源操作的工作区通知", () => {
  it("已加载的同一修订通知不会取消正在整理的选择", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="a"]')!, { key: " " });
    expect(screen.getByText("已选 1 张")).toBeTruthy();
    await act(() => emit("workspace-changed", { revision: "fixture", libraries: [{ library, unavailable: null }] }));
    expect(screen.getByText("已选 1 张")).toBeTruthy();
  });
});
