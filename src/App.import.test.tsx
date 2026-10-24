import { workspaceFixture } from "./test/workspace-fixture";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import { library, clean, backend, sent, push, importAction, chooseDestination, confirmImport } from "./App.fixtures";

describe("主窗口", () => {
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
    expect(screen.getByRole("progressbar", { name: "导入进度" }).getAttribute("aria-valuenow")).toBe("1");
    expect(within(screen.getByRole("region", { name: "导入进度" })).getByText("1 / 4")).toBeTruthy();
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

    // 拖放监听异步注册：等它就绪；先选好保存位置（原先在点开的导入面板里选）。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await chooseDestination();
    const position = { x: 10, y: 10 };
    await act(() =>
      emit("tauri://drag-enter", { paths: ["D:\\图\\a.png", "D:\\一批参考"], position }),
    );
    expect(screen.getByText("松开即可导入，再选放在哪里")).toBeTruthy();
    await act(() => emit("tauri://drag-drop", { paths: ["D:\\图\\a.png", "D:\\一批参考"], position }));
    await confirmImport();

    await waitFor(() =>
      expect(sent("plugin:library|start_import")).toEqual([
        { libraryId: "L1", source: { paths: ["D:\\图\\a.png", "D:\\一批参考"] }, options:{eagleDeletedContent:"skipDeleted"}, destination:{libraryId:"L1",folderId:null} },
      ]),
    );
    expect(screen.queryByText("松开即可导入，再选放在哪里")).toBeNull();
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

  it("打标卡片不再占侧栏；缩放滑块左边的打标图标打开设置 › 自动标签（#144）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const icon = await screen.findByRole("button", { name: /自动标签：正在加载自动标签模型/ });
    expect(document.querySelector(".side-foot .tagging")).toBeNull();
    expect(screen.queryByText(/自动标签：正在加载自动标签模型…/)).toBeNull();
    expect(icon.nextElementSibling?.getAttribute("aria-label")).toBe("图片大小");

    fireEvent.click(icon);
    const dialog = await screen.findByRole("dialog", { name: "程序设置" });
    expect(await within(dialog).findByRole("heading", { name: "自动标签", level: 3 })).toBeTruthy();
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
    const files = importButton();
    expect(files.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.keyDown(files, { key: "Escape" });
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

    expect(within(screen.getByRole("region", { name: "导入进度" })).getByText("1 / 3")).toBeTruthy();
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

    expect(within(screen.getByRole("region", { name: "导入进度" })).getByText("1 / 5")).toBeTruthy();
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
    fireEvent.click(importAction("从 Eagle 导入…"));
    fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
    await confirmImport();
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

    // 标签对应是模态对话框：结果卡留在原处（对话框打开时不在读屏树里）。
    expect(screen.getByRole("region", { name: "导入结果", hidden: true })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(sent("plugin:library|start_import")).toHaveLength(4));
    await finished("T3");
    await answer("T3");
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
  });
});

