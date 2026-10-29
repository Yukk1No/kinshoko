import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { BrowsePage } from "./bindings/BrowsePage";
import { App } from "./App";
import { library, page, clean, backend, sent, selectionPanel, push, importAction, chooseDestination, libraryAction, openLibrary, confirmImport } from "./App.fixtures";

describe("主窗口", () => {
  it("打开另一个图库时清空选择与导入状态，迟到的旧库浏览和进度不会覆盖新库", async () => {
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
    await openLibrary();
    await act(() => resolveOld(page));
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 2, total: 4 } });
    await push({ kind: "taskFinished", libraryId: "L1", taskId: "T1", report: { cancelled: true, items: [], fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0, eagleRelocations: [] } });

    expect(await screen.findByText("图库里还没有参考图。点右上角的“导入”，或直接拖进窗口。")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(selectionPanel()).toBeNull();
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

    await libraryAction(/新建图库/);
    await screen.findByLabelText("图库名称");
    // 等待页面切换的事件订阅清理，模拟导入在用户填写表单期间完成。
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    if (stage === "进行中") await finish();
    fireEvent.click(screen.getByRole("button", { name: "返回图库" }));

    expect(await screen.findByText("D:\\参考\\坏.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toEqual([
      { libraryId: "L1", source: { paths: ["D:\\参考"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
      { libraryId: "L1", source: { paths: ["D:\\参考\\坏.png"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
    ]));
  });

  it.each([
    ["是同一个库", { kind: "moved", sourceId: "S1" }],
    ["是另一个库", { kind: "separate" }],
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

    const prompt = await screen.findByRole("alert", { name: "Eagle 库换了位置？" });
    expect(within(prompt).getByText(/100% 的图已经从另一个位置导入过/)).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: button }));
    fireEvent.click(await screen.findByRole("button", { name: "开始导入" }));
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
    expect(screen.queryByRole("alert", { name: "Eagle 库换了位置？" })).toBeNull();
  });

  it("新建资料库页不接受拖放导入，返回当前库后恢复拖放", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    // 拖放监听异步注册：等它就绪；先选好保存位置（原先在点开的导入面板里选）。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await chooseDestination();
    const position = { x: 10, y: 10 };
    const paths = ["D:\\参考\\a.png"];
    await act(() => emit("tauri://drag-enter", { paths, position }));
    expect(screen.getByText("松开即可导入，再选放在哪里")).toBeTruthy();
    await libraryAction(/新建图库/);
    await screen.findByLabelText("图库名称");
    await act(() => emit("tauri://drag-drop", { paths, position }));
    expect(sent("plugin:library|start_import")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "返回图库" }));
    expect(screen.queryByText("松开即可导入，再选放在哪里")).toBeNull();
    await act(() => emit("tauri://drag-drop", { paths, position }));
    await confirmImport();
    await waitFor(() => expect(sent("plugin:library|start_import")).toEqual([
      { libraryId: "L1", source: { paths }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
    ]));
  });

  it("选择导入文件的对话框等待期间打开另一个图库，迟到的选择不会导入新库", async () => {
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
    await openLibrary();
    await act(() => resolvePick(["D:\\参考.png"]));
    expect(sent("plugin:library|start_import")).toEqual([]);
  });

  it("未连接的图库在侧栏只占一行并可就地重新连接，管理图库里显示原因（#113）", async () => {
    const other = { id: "L2", name: "移动盘参考", root: "E:\\移动盘参考" };
    const reason = "资料库暂时不可用：E:\\移动盘参考。请确认移动盘已连接，搬家后重新登记。";
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [
        { library, unavailable: null }, { library: other, unavailable: reason },
      ];
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    const offline = await screen.findByRole("button", { name: "移动盘参考（未连接）" });
    expect(offline).toHaveProperty("disabled", true);
    const group = offline.closest("section")!;
    // 设计系统 v2：不再另起一行说明，“重新连接”在图库名同一行末尾。
    expect(within(group).queryByRole("status")).toBeNull();
    const reads = sent("plugin:library|registered_libraries").length;
    fireEvent.click(within(group).getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(sent("plugin:library|registered_libraries").length).toBeGreaterThan(reads));
    await libraryAction(/管理图库/);
    const manage = await screen.findByRole("dialog", { name: "管理图库" });
    expect(within(manage).getByText(reason)).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "打开图库…" })).toBeTruthy();
    expect(within(manage).getByRole("button", { name: "移除 移动盘参考" })).toBeTruthy();
  });

  it("在程序设置里显示核心报告的版本", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("Kinshoko 9.9.9")).toBeTruthy();
  });

  it("设置读不出来时，设置对话框仍有关闭按钮，并显示原因与重试", async () => {
    backend(library, clean, (cmd) => cmd === "shell_settings" ? Promise.reject("设置文件被占用") : undefined);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = await screen.findByRole("dialog", { name: "程序设置" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("设置文件被占用");
    expect(within(dialog).getByRole("button", { name: "重试" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "程序设置" })).toBeNull());
  });

  it("没有资料库时引导建库：选新建，选择存放位置后在那里新建并打开", async () => {
    backend(null);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "欢迎使用 Kinshoko" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建图库" }));
    fireEvent.change(await screen.findByLabelText("图库名称"), {
      target: { value: "工作参考" },
    });
    expect((screen.getByRole("button", { name: "建立图库" }) as HTMLButtonElement).disabled).toBe(true);
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\参考"];
    fireEvent.click(within(screen.getByRole("group", { name: "存放位置" })).getByRole("button", { name: "选择存放位置…" }));
    expect(await screen.findByText("D:\\参考\\工作参考")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "建立图库" }));

    expect(await screen.findByRole("button", { name: "工作参考（2 张）" })).toBeTruthy();
    expect(sent("plugin:library|create_library")).toEqual([
      { parent: "D:\\参考", name: "工作参考" },
    ]);
  });

  it("没有资料库时新建表单的“返回”回到欢迎页；打开图库登记所选文件夹", async () => {
    backend(null);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "新建图库" }));
    await screen.findByLabelText("图库名称");
    expect(screen.queryByRole("button", { name: "返回图库" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    window.__KINSHOKO_TEST_PICKS__ = ["E:\\私人收藏"];
    fireEvent.click(await screen.findByRole("button", { name: "打开图库" }));
    await waitFor(() => expect(sent("plugin:library|register_library")).toEqual([{ root: "E:\\私人收藏" }]));
  });

  it("打开的资料库在图片墙上按资料库记录的比例显示缩略图", async () => {
    backend(library);
    render(<App />);

    const images = await screen.findAllByRole("img");
    expect(images.map((i) => i.getAttribute("src"))).toEqual([
      "http://thumb.localhost/L1/a/384",
      "http://thumb.localhost/L1/b/384",
    ]);
    const box = (el: HTMLElement) => el.closest<HTMLElement>("[data-id]")!.style;
    const ratio = (s: CSSStyleDeclaration) => parseFloat(s.height) / parseFloat(s.width);
    expect(ratio(box(images[0]))).toBeCloseTo(2, 3);
    expect(ratio(box(images[1]))).toBeCloseTo(1 / 3, 3);
  });

});

describe("导入快捷键 Ctrl O", () => {
  it("在图片墙上打开选择文件；设置等对话框开着时不响应", async () => {
    backend(library, clean, (cmd) => (cmd === "plugin:library|pick_files" ? [] : undefined));
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await waitFor(() => expect(sent("plugin:library|pick_files").length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(sent("plugin:library|pick_files").length).toBe(1);
  });
});
