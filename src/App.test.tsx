import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowsePage } from "./bindings/BrowsePage";
import type { ImageDetail } from "./bindings/ImageDetail";
import type { LibraryEvent } from "./bindings/LibraryEvent";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { Sidebar } from "./bindings/Sidebar";
import type { RecoveryReport } from "./bindings/RecoveryReport";
import { App } from "./App";

const info: AppInfo = { productName: "Kinshoko", version: "9.9.9" };
const library: LibraryInfo = { id: "L1", name: "工作参考", root: "D:\\参考\\工作参考" };
const page: BrowsePage = {
  cards: [
    { id: "a", width: 100, height: 200, thumbnail: "L1/a/256" },
    { id: "b", width: 300, height: 100, thumbnail: "L1/b/256" },
  ],
  nextCursor: null,
  total: 2,
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
});

type Call = { cmd: string; args: unknown };
let calls: Call[];

const clean: RecoveryReport = { interrupted: [], orphans: [], discardedStaging: 0 };

function backend(opened: LibraryInfo | null, recovery: RecoveryReport = clean) {
  calls = [];
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
          return page;
        case "plugin:library|start_import":
          return "T1";
        case "plugin:library|sidebar":
          return side;
        case "plugin:library|image":
          return detail((args as { imageId: string }).imageId, null);
        case "plugin:library|edit": {
          const { ids, edits } = args as { ids: string[]; edits: { kind: string; text?: string }[] };
          const note = edits.find((e) => e.kind === "setNote")?.text ?? null;
          return ids.map((id) => detail(id, note));
        }
        case "plugin:library|recovery":
          return recovery;
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
});

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("主窗口", () => {
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
