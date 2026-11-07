import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { library, clean, backend, sent, selectionPanel, push, importAction, libraryAction, openLibrary, confirmImport } from "./App.fixtures";

describe("主窗口", () => {
  it("打开另一个图库不动选择和进行中的导入（ADR-0008）", async () => {
    const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="a"]')!, { key: " " });
    await waitFor(() => expect(selectionPanel()).toBeTruthy());
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 1, total: 4 } });

    await openLibrary();
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 2, total: 4 } });

    expect(selectionPanel()).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "导入进度" })).getByText("2 / 4")).toBeTruthy();
  });

  it.each(["进行中", "已结束"])("导入%s时打开新建图库对话框再取消，保留结果和重试入口", async (stage) => {
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
        items: [{ path: "D:\\参考\\坏.png", outcome: { kind: "readFailed", reason: { code: "system", detail: "被占用" } } }],
      },
    });
    if (stage === "已结束") await finish();

    await libraryAction(/新建图库/);
    const dialog = await screen.findByRole("dialog", { name: "新建图库" });
    within(dialog).getByLabelText("图库名称");
    // 模拟导入在用户填写表单期间完成。
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    if (stage === "进行中") await finish();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建图库" })).toBeNull());

    // 有未导入的项，结束的轻提示一直留着；它的“查看”打开结果回执（#388）。
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: /^未导入/ }));
    expect(screen.getByText("D:\\参考\\坏.png")).toBeTruthy();
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

  it("已有图库时新建图库是对话框：图片墙一直在，建好后关掉对话框并打开新图库（#442）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");

    await libraryAction(/新建图库/);
    const dialog = await screen.findByRole("dialog", { name: "新建图库" });
    expect(document.querySelector('[data-id="a"]')).toBeTruthy();
    expect(document.querySelector(".app-empty-workspace")).toBeNull();
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\新"];
    fireEvent.click(within(dialog).getByRole("button", { name: "选择存放位置…" }));
    expect(await within(dialog).findByText("D:\\新\\我的参考")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "建立图库" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建图库" })).toBeNull());
    expect(sent("plugin:library|create_library")).toEqual([{ parent: "D:\\新", name: "我的参考" }]);
    expect(sent("plugin:library|create_library_unopened")).toEqual([]);
    expect(document.querySelector('[data-id="a"]')).toBeTruthy();
  });

  it("选择导入文件的对话框等待期间打开另一个图库，迟到的选择也要先确认保存位置", async () => {
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
    const reason = "图库暂时无法连接：E:\\移动盘参考。请确认移动盘已连接，搬家后重新登记。";
    const unavailable = { code: "system" as const, detail: reason };
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [
        { library, unavailable: null }, { library: other, unavailable },
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

  it("没有图库时新建图库预填系统的图片文件夹", async () => {
    backend(null, clean, (cmd) => (cmd === "plugin:library|pictures_folder" ? "C:\\Users\\画师\\Pictures" : undefined));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建图库" }));
    expect(await screen.findByText("C:\\Users\\画师\\Pictures\\我的参考")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "建立图库" }));
    await waitFor(() => expect(sent("plugin:library|create_library")).toEqual([
      { parent: "C:\\Users\\画师\\Pictures", name: "我的参考" },
    ]));
    // 预填的位置不写进“上次新建资料库的位置”。
    expect(sent("plugin:library|remember_new_library_parent")).toEqual([]);
  });

  it("已有图库时新建图库预填到那个图库旁边", async () => {
    backend(library, clean, (cmd) => (cmd === "plugin:library|pictures_folder" ? "C:\\Users\\画师\\Pictures" : undefined));
    render(<App />);
    await screen.findAllByRole("img");
    await libraryAction(/新建图库/);
    expect(await screen.findByText("D:\\参考\\我的参考")).toBeTruthy();
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
