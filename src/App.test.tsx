import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function backend(opened: LibraryInfo | null, recovery: RecoveryReport = clean, safe = true) {
  calls = [];
  safeOn = safe;
  gone = new Set();
  mockWindows("main");
  let current = opened;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      switch (cmd) {
        case "app_info":
          return info;
        case "plugin:library|current_library":
          return current;
        case "plugin:library|create_library":
          current = library;
          return library;
        case "plugin:library|browse":
          return safeOn ? page : released;
        case "plugin:library|safe_mode":
          return safeOn;
        case "plugin:library|set_safe_mode":
          safeOn = (args as { on: boolean }).on;
          return safeOn;
        case "plugin:library|start_import":
          return "T1";
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
        case "shell_settings":
          return { autostart: true, shortcuts: [], showApproxSource };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const push = (event: LibraryEvent) => act(() => emit("library-event", event));

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
});

describe("主窗口", () => {
  it("单击仍选中，双击打开原图；Esc 返回原位置并把焦点交还参考图", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = document.querySelector<HTMLElement>(".wall")!;
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    wall.scrollTop = 120;
    fireEvent.scroll(wall);
    fireEvent.click(card);
    expect(screen.queryByRole("dialog", { name: "原图查看器" })).toBeNull();
    expect(screen.getByText("已选 1 张")).toBeTruthy();

    fireEvent.doubleClick(card);
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
    backend(library, clean, false);
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

    expect(await screen.findByRole("heading", { name: "工作参考" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "导入文件夹…" }));
    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { source: { paths: ["D:\\下载\\参考"] } },
      ]),
    );

    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 4 } });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByText("正在导入 1 / 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消导入" }));
    await waitFor(() => expect(sent("plugin:library|cancel_import")).toEqual([{ taskId: "T1" }]));

    const browsed = sent("plugin:library|browse").length;
    await push({ kind: "listStale", libraryId: "L1" });
    await waitFor(() => expect(sent("plugin:library|browse").length).toBeGreaterThan(browsed));

    await push({
      kind: "taskFinished",
      libraryId: "L1",
      taskId: "T1",
      report: {
        cancelled: true,
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

    const position = { x: 10, y: 10 };
    await act(() =>
      emit("tauri://drag-enter", { paths: ["D:\\图\\a.png", "D:\\一批参考"], position }),
    );
    expect(screen.getByText("松开即可导入到 工作参考")).toBeTruthy();
    await act(() => emit("tauri://drag-drop", { paths: ["D:\\图\\a.png", "D:\\一批参考"], position }));

    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { source: { paths: ["D:\\图\\a.png", "D:\\一批参考"] } },
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
        items: [
          { path: "D:\\参考\\a.png", outcome: { kind: "imported", imageId: "a" } },
          { path: "D:\\参考\\说明.txt", outcome: { kind: "unsupported" } },
          { path: "D:\\参考\\坏.png", outcome: { kind: "readFailed", reason: "被占用" } },
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));

    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { source: { paths: ["D:\\参考\\坏.png"] } },
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

    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { source: { paths: ["D:\\参考\\b.png"] } },
      ]),
    );
  });

  it("从状态栏打开设置", async () => {
    mockIPC((cmd) => {
      if (cmd === "app_info") return { productName: "Kinshoko", version: "9.9.9" };
      if (cmd === "shell_settings") return { autostart: true, shortcuts: [] };
      return undefined;
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("region", { name: "设置" })).toBeTruthy();
  });
});

describe("整理", () => {
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

  it("侧栏列出全部、文件夹树与回收站及其计数，点文件夹按文件夹浏览", async () => {
    backend(library);
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "侧栏" });
    await waitFor(() => expect(nav.textContent).toContain("发型"));
    expect(screen.getByRole("button", { name: "全部（2 张）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "人物（1 张）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "回收站（1 张）" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "发型（0 张）" }));
    await waitFor(() =>
      expect(sent("plugin:library|browse").at(-1)).toMatchObject({
        query: { scope: { kind: "folder", id: "F2" } },
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
      expect(sent("plugin:library|create_folder")).toEqual([{ name: "姿势", parent: "F1" }]),
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "发型（0 张）" }));
    const rename = screen.getByLabelText("文件夹名称");
    fireEvent.change(rename, { target: { value: "发型与刘海" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() =>
      expect(sent("plugin:library|rename_folder")).toEqual([{ folderId: "F2", name: "发型与刘海" }]),
    );
  });

  it("选中多张图后批量放入文件夹、删除；回收站里恢复", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(card("a"));
    fireEvent.click(card("b"), { ctrlKey: true });
    expect(screen.getByText("已选 2 张")).toBeTruthy();

    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("放入文件夹"), { target: { value: "F2" } });
    await waitFor(() =>
      expect(sent("plugin:library|edit")).toEqual([
        { ids: ["a", "b"], edits: [{ kind: "addToFolder", folderId: "F2" }] },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ ids: ["a", "b"], edits: [{ kind: "delete" }] }),
    );
    await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "回收站（1 张）" }));
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.click(card("a"));
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ ids: ["a"], edits: [{ kind: "restore" }] }),
    );
  });

  it("只选一张时写备注，并能退回来源的备注", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(card("a"));
    expect(await screen.findByText("所在文件夹：人物")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "看左手" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({
        ids: ["a"],
        edits: [{ kind: "setNote", text: "看左手" }],
      }),
    );
    const revert = screen.getByRole("button", { name: "退回来源备注" });
    await waitFor(() => expect((revert as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(revert);
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ ids: ["a"], edits: [{ kind: "revertNote" }] }),
    );
  });
});

describe("查找", () => {
  const box = () => screen.findByRole("combobox", { name: "查找参考图" });
  const lastInput = () => (sent("plugin:library|resolve_search").at(-1) as { input: SearchInput }).input;
  const lastQuery = () =>
    (sent("plugin:library|browse").at(-1) as { query: { conditions: ConditionTree } }).query;

  it("输入的词命中多个命名空间与别名时，下拉按命名空间与别名列出候选", async () => {
    backend(library);
    render(<App />);
    fireEvent.change(await box(), { target: { value: "某某" } });

    const options = () => within(screen.getByRole("listbox", { name: "" })).getAllByRole("option");
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(options().map((o) => o.textContent)).toEqual([
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
    render(<App />);
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
      expect(sent("plugin:library|set_tag_approx")).toEqual([{ a: "B", b: "Q", relation: "notSimilar" }]),
    );
    expect(screen.queryByRole("dialog", { name: "不展开相近标签" })).toBeNull();
  });

  it("用“＋”从库内标签里挑一个加为相近标签", async () => {
    backend(library);
    render(<App />);
    await pickBlue();

    fireEvent.click(screen.getByRole("button", { name: "给“蓝发”加相近标签" }));
    const dialog = screen.getByRole("dialog", { name: "加相近标签" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "挑一个库内标签" }), {
      target: { value: "某" },
    });
    fireEvent.click(await within(dialog).findByRole("option", { name: /作者：某某/ }));

    await waitFor(() =>
      expect(sent("plugin:library|set_tag_approx")).toEqual([{ a: "B", b: "A", relation: "similar" }]),
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
    backend(library, clean, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")?.dataset.veiled).toBe("false"));
    expect(cardOf("a")?.dataset.veiled).toBe("false");

    fireEvent.click(await book());
    // 不等后端：点下的这一帧就开始遮蔽。
    expect(cardOf("x")?.dataset.veiled).toBe("true");
    expect(cardOf("a")?.dataset.veiled).toBe("false");

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
    expect(cardOf("x")?.dataset.veiled).toBe("true");
  });

  it("开启后清掉选中的图，侧栏计数随之刷新", async () => {
    backend(library, clean, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    fireEvent.click(cardOf("x")!);
    expect(screen.getByText("已选 1 张")).toBeTruthy();
    const sidebars = sent("plugin:library|sidebar").length;

    fireEvent.click(await book());
    await changed(true);
    await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());
    await waitFor(() => expect(sent("plugin:library|sidebar").length).toBeGreaterThan(sidebars));
  });
});
