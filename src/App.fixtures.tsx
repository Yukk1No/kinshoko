import { useEffect, useState } from "react";
import { SearchBox } from "./search/SearchBox";
import { useUiLang } from "./i18n";
import { onLibraryEvent, setSafeMode, workspaceResolve } from "./ipc";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
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
import type { CatalogImageTags } from "./bindings/CatalogImageTags";
import type { LibraryRegistration } from "./bindings/LibraryRegistration";
import type { WorkspaceDirectories } from "./bindings/WorkspaceDirectories";
import type { WorkspacePage } from "./bindings/WorkspacePage";
import type { WorkspaceStatus } from "./bindings/WorkspaceStatus";
import { chooseValue } from "./test/select";
import { fakeBackend } from "./test/backend";
import { wallPage as toWallPage } from "./test/workspacePage";

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
  taggingFailure: null,
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
        if (t.kind === "rating") return { kind: "rating" as const, rating: { ratings: t.ratings, r18: false } };
        if (t.kind === "taggingUnfinished") return { kind: "taggingUnfinished" as const };
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
/** 详情面板的开合。这些用例多在面板里操作，默认开着；要看关着时的行为用 `setInspectorOpen`。 */
export let inspectorOpen = true;
export let calls: Call[];
/** 后端的安全模式开关。 */
export let safeOn = true;
/** 后端查不到的图（已删除或被封印）：查询返回 UnknownImage。 */
export let gone = new Set<string>();
/** 测试文件不能给导入的绑定赋值：改共享状态走这几个函数。 */
export const setShowApproxSource = (on: boolean) => { showApproxSource = on; };
export const setKeepSelectionOnSafeMode = (on: boolean) => { keepSelectionOnSafeMode = on; };
export const setInspectorOpen = (on: boolean) => { inspectorOpen = on; };
export const setCalls = (next: Call[]) => { calls = next; };
export const setSafeOn = (on: boolean) => { safeOn = on; };

export const clean: RecoveryReport = { interrupted: [], orphans: [], discardedStaging: 0 };

/** 图片墙一页（今天的 `workspace_browse` 回答），卡片默认属于 `library`。 */
export const wallPage = (result: BrowsePage, owner: Pick<LibraryInfo, "id" | "name"> = library, revision?: string): WorkspacePage =>
  toWallPage(result, owner, revision);

export function backend(opened: LibraryInfo | null, recovery: RecoveryReport = clean,
  override?: (cmd: string, args: unknown) => unknown, safe = true) {
  calls = [];
  safeOn = safe;
  gone = new Set();
  let current = opened;
  let tasks = 0;
  let revision = 0;
  type Args = Record<string, unknown>;
  /** 记下命令、先让用例改写，再按下面的默认回答；没有默认回答的命令答 null。 */
  const answer = (cmd: string, args: Args = {}): unknown => {
    calls.push({ cmd, args });
    const overridden = override?.(cmd, args);
    if (overridden !== undefined) return overridden;
    const reply = replies[cmd.replace(/^plugin:[^|]+\|/, "")];
    return reply ? reply(args) : null;
  };
  const status = () => Promise.resolve(answer("plugin:library|registered_libraries")).then((libraries): WorkspaceStatus => ({
    revision: `fixture-${revision}`, libraries: (libraries ?? []) as LibraryRegistration[],
  }));
  /** 登记变化后后端推送的通知：界面靠它重读，不靠“换了资料库”。 */
  const registrationChanged = () => { revision++; void status().then((next) => emit("workspace-changed", next)); };
  const replies: Record<string, (args: Args) => unknown> = {
    app_info: () => info,
    current_library: () => current,
    create_library: () => current = library,
    registered_libraries: () => current ? [{ library: current, unavailable: null }] : [],
    register_library: (args) => current = { id: "L2", name: "私人收藏", root: args.root as string },
    unregister_library: () => { current = null; return null; },
    workspace_status: () => status(),
    workspace_directories: () => Promise.resolve(answer("plugin:library|registered_libraries")).then(async (value) => {
      const libraries = (value ?? []) as LibraryRegistration[];
      return { status: { revision: `fixture-${revision}`, libraries }, registrationOrder: libraries.map((entry) => entry.library.id), providers: await Promise.all(libraries.map(async (registration) => ({
        registration, unassigned: 0, descendants: {},
        sidebar: registration.unavailable ? null : await answer("plugin:library|workspace_sidebar", { libraryId: registration.library.id }) as Sidebar,
      }))) } satisfies WorkspaceDirectories;
    }),
    workspace_browse: (args) => {
      const scope = (args.query as { scope: { libraryId?: string } }).scope;
      const owner = { ...(current ?? library), id: scope.libraryId ?? current?.id ?? "L1", name: current?.name ?? "fixture" };
      return wallPage(safeOn ? page : released, owner, `fixture-${revision}`);
    },
    workspace_sidebar: () => side,
    workspace_tag_groups: () => [],
    workspace_local_tags: (args) => args.ids,
    rating_candidates: () => [],
    safe_mode: () => safeOn,
    set_safe_mode: (args) => { safeOn = args.on as boolean; return safeOn; },
    import_tasks: () => [],
    // 后端每个任务的 id 都不同。
    start_import: () => `T${++tasks}`,
    image: (args) => {
      const imageId = args.imageId as string;
      if (gone.has(imageId)) return Promise.reject({ code: "unknownImage" });
      return detail(imageId, null);
    },
    catalog_image_tags: (args) => ({ image: { imageId: args.imageId as string, tags: [], rejected: [] }, identities: [] }) satisfies CatalogImageTags,
    edit: (args) => {
      const { ids, edits } = args as { ids: string[]; edits: { kind: string; text?: string }[] };
      const note = edits.find((e) => e.kind === "setNote")?.text ?? null;
      return ids.map((id) => detail(id, note));
    },
    workspace_edit_sources: () => [],
    recovery: () => recovery,
    workspace_candidates: (args) => (args.text as string).trim() ? candidates : [],
    workspace_library_candidates: (args) => (args.text as string).trim() ? candidates : [],
    search_candidates: (args) => (args.text as string).trim() ? candidates : [],
    workspace_resolve: (args) => resolved(args.input as SearchInput),
    tagging_status: () => ({ state: "starting" }),
    shell_settings: () => ({ autostart: true, shortcuts: [], showApproxSource, keepSelectionOnSafeMode, inspectorOpen }),
  };
  // 过渡期（#520）：这些用例实际发出的命令都交给 answer，没列出的命令由 fakeBackend 拒绝。
  // 阶段三把各用例改成直接向 fakeBackend 登记回答时，这张表删掉。
  const fake = fakeBackend();
  for (const command of APP_COMMANDS) fake.on(command, (args) => answer(command, args));
  for (const command of REGISTRATION_COMMANDS) {
    fake.on(command, (args) => Promise.resolve(answer(command, args)).then((value) => { registrationChanged(); return value; }));
  }
}

/** App 用例实际发出的命令（完整命令名，交给转译层时要带前缀）。 */
const APP_COMMANDS = [
  "app_info", "backup_status", "double_click", "log_frontend", "log_timing", "migrate_viewer_background",
  "plugin:desktop|capture_history", "plugin:desktop|clipboard_has_image", "plugin:desktop|reference_groups",
  "plugin:desktop|stage_clipboard_import", "plugin:desktop|take_collection_request",
  "plugin:desktop|take_open_request", "plugin:library|cancel_import", "plugin:library|catalog_image_tags",
  "plugin:library|confirm_eagle_location", "plugin:library|create_folder", "plugin:library|create_library",
  "plugin:library|current_library", "plugin:library|discover_eagle_libraries", "plugin:library|eagle_tag_mapping",
  "plugin:library|edit", "plugin:library|image", "plugin:library|import_contains_eagle",
  "plugin:library|import_tasks", "plugin:library|permanent_delete", "plugin:library|pick_files",
  "plugin:library|pictures_folder", "plugin:library|plan_legacy_names", "plugin:library|preview_permanent_delete",
  "plugin:library|rating_candidates", "plugin:library|recovery", "plugin:library|register_library",
  "plugin:library|registered_libraries", "plugin:library|remember_new_library_parent",
  "plugin:library|rename_folder", "plugin:library|safe_mode",
  "plugin:library|save_memory", "plugin:library|search_candidates", "plugin:library|set_safe_mode",
  "plugin:library|set_tag_approx", "plugin:library|start_import", "plugin:library|unregister_library",
  "plugin:library|workspace_browse", "plugin:library|workspace_candidates", "plugin:library|workspace_card",
  "plugin:library|workspace_directories", "plugin:library|workspace_edit_sources",
  "plugin:library|workspace_resolve", "plugin:library|workspace_sidebar", "plugin:library|workspace_status",
  "plugin:library|workspace_tag_groups", "plugin:window|is_maximized", "change_setting:inspectorOpen", "change_setting:inspectorWidth",
  "set_ui_scale", "change_setting:viewerBackground", "shell_settings", "subscription_recent", "subscription_status",
  "subscriptions", "tagging_models", "tagging_status", "ui_scale", "update_status",
];
/** 改变登记的命令：回答之后后端推送 workspace-changed。 */
const REGISTRATION_COMMANDS = ["plugin:library|create_library", "plugin:library|register_library", "plugin:library|switch_library", "plugin:library|unregister_library"];

/** Existing library-local approximation controls remain separate until global rules (T06) land. */
export function LocalSearchFixture() {
  const lang = useUiLang();
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
  // biome-ignore lint/correctness/useExhaustiveDependencies(generation): 资料库有变动就重新解析搜索
  useEffect(() => {
    let alive = true;
    workspaceResolve(input, lang, safe).then((tree) => alive && setTree(tree), () => {});
    return () => { alive = false; };
  }, [input, safe, generation, lang]);
  return <>
    <button type="button" aria-label={`安全模式：${safe ? "开启" : "关闭"}`} aria-pressed={safe}
      onClick={() => { setSafe(!safe); void setSafeMode(!safe); }}>安全模式</button>
    <SearchBox libraryId={library.id} safe={safe} generation={generation} input={input} tree={tree}
      showSource={false} onChange={setInput} onError={() => {}} />
  </>;
}

export const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
/** 最后一次发出 `cmd` 之后，图片墙又浏览过。 */
export const browsedAfter = (cmd: string) => {
  const order = calls.map((c) => c.cmd);
  return order.includes(cmd) && order.lastIndexOf("plugin:library|workspace_browse") > order.lastIndexOf(cmd);
};
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
  // 今天的图片墙按全部图库浏览，不带图库：等登记 L2 之后它重读一次。
  await waitFor(() => expect(browsedAfter("plugin:library|register_library")).toBe(true));
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
  inspectorOpen = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

