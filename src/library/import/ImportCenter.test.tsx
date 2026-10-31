import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { ImportTaskSnapshot } from "../../bindings/ImportTaskSnapshot";
import type { RunningImport } from "./report";
import { ImportCenter } from "./ImportCenter";
import { ToastProvider } from "../../ui/Toast";

afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); clearMocks(); vi.unstubAllGlobals(); });

const receipt: ImportTaskSnapshot = {
  taskId: "actual-task", destination: { libraryId: "L1", folderId: null }, libraryName: "参考", folderName: "未归类",
  progress: { done: 3, total: 3 }, finishing: false, warnings: [],
  report: { cancelled: false, fromEagle: false, eagleMissing: 0, eagleRelocations: [], sealedDuplicates: false, privateSummary: false, trashDuplicates: false,
    items: [ { path: "sealed-name.png", outcome: { kind: "merged", imageId: "sealed-id" } }, { path: "visible-name.png", outcome: { kind: "refreshed", imageId: "visible-id" } }, { path: "D:\\参考\\missing.png", outcome: { kind: "readFailed", reason: "missing" } } ] },
};
const clean = { ...receipt, report: { ...receipt.report!, items: [{ path: "a.png", outcome: { kind: "imported" as const, imageId: "a" } }] } };

function center(running: RunningImport | null = null) {
  return <ImportCenter enabled libraryId="L1" running={running} finished={null} onStarted={() => {}} onDismissReport={() => {}} />;
}
function serve(tasks: ImportTaskSnapshot[] | (() => unknown), more?: (cmd: string, args: unknown) => unknown) {
  mockWindows("main");
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|import_tasks") return typeof tasks === "function" ? tasks() : tasks;
    if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
    return more?.(cmd, args);
  }, { shouldMockEvents: true });
}
const trigger = () => screen.getByRole("button", { name: /^(导入|正在导入)$/ });
const panel = () => {
  if (!screen.queryByRole("dialog", { name: "导入" })) fireEvent.click(trigger());
  return screen.getByRole("dialog", { name: "导入" });
};
const receiptRow = () => screen.findByRole("region", { name: "导入回执：参考 / 未归类" });
const toastOf = (title: string) => screen.getByText(title, { selector: ".k-toast-title" }).closest(".k-toast")!;

describe("导入按钮与弹层（#388）", () => {
  it("一个无底按钮打开弹层，上半是来源：图片（Ctrl O）、文件夹、从 Eagle 导入", async () => {
    serve([], (cmd) => cmd === "plugin:library|pick_folder" ? null : undefined);
    render(center());
    expect(trigger().textContent).toBe("");
    const sources = within(panel()).getByRole("group", { name: "导入来源" });
    expect(within(sources).getAllByRole("button").map((b) => b.textContent)).toEqual(["图片Ctrl O", "文件夹", "从 Eagle 导入"]);
    // 没有任务时只有来源，不放解释性的提示行。
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByLabelText("导入任务")).toBeNull();
  });

  it("导入中按钮标明忙碌、带进度环；来源不可用，弹层里是进度与取消", async () => {
    const running = { ...receipt, report: null, progress: { done: 1, total: 4 } };
    const cancelled: unknown[] = [];
    serve([running], (cmd, args) => { if (cmd === "plugin:library|cancel_import") cancelled.push(args); return undefined; });
    render(center());
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("正在导入"));
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(trigger().querySelector(".k-import-ring-arc")?.getAttribute("stroke-dasharray")).toBe("25 100");
    const pop = panel();
    for (const source of within(within(pop).getByRole("group", { name: "导入来源" })).getAllByRole("button")) expect(source).toHaveProperty("disabled", true);
    const row = within(pop).getByRole("group", { name: "导入进度" });
    expect(within(row).getByText("参考 / 未归类")).toBeTruthy();
    expect(within(row).getByText("1 / 4")).toBeTruthy();
    expect(within(row).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    fireEvent.click(within(row).getByRole("button", { name: "取消导入" }));
    await waitFor(() => expect(cancelled).toEqual([{ libraryId: "L1", taskId: "actual-task" }]));
  });

  it("有没看过的未导入时按钮挂红点，展开那条回执后点消失", async () => {
    serve([receipt]);
    render(center());
    await waitFor(() => expect(trigger().querySelector(".k-import-dot")?.getAttribute("data-tone")).toBe("danger"));
    expect(trigger().getAttribute("title")).toBe("导入：有未导入的文件");
    fireEvent.click(within(panel()).getByRole("button", { name: "参考 / 未归类，导入完成" }));
    await receiptRow();
    expect(trigger().querySelector(".k-import-dot")).toBeNull();
  });

  it("回执：四栏数字，未导入的子菜单列出文件名、原因与所在文件夹，点一项在资源管理器中显示", async () => {
    const revealed: unknown[] = [];
    const copied: string[] = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } });
    serve([receipt], (cmd, args) => { if (cmd === "plugin:desktop|reveal_import_source") revealed.push(args); return undefined; });
    render(center());
    fireEvent.click(await within(panel()).findByRole("button", { name: "参考 / 未归类，导入完成" }));
    const row = await receiptRow();
    expect(row.querySelector(".k-import-nums")?.textContent).toBe("0新增1已存在1更新0新版本");
    fireEvent.click(within(row).getByRole("button", { name: /^未导入/ }));
    const files = await screen.findByRole("dialog", { name: "未导入" });
    expect(within(files).getByText("missing.png")).toBeTruthy();
    expect(within(files).getByText("missing")).toBeTruthy();
    expect(within(files).getByText("D:\\参考\\")).toBeTruthy();
    fireEvent.click(within(files).getByTitle("在资源管理器中显示：D:\\参考\\missing.png"));
    await waitFor(() => expect(revealed).toEqual([{ path: "D:\\参考\\missing.png" }]));
    fireEvent.click(within(files).getByRole("button", { name: "复制全部路径" }));
    expect(copied).toEqual(["D:\\参考\\missing.png"]);
  });

  it("移除记录：后端回执与按钮上的点一起去掉", async () => {
    let tasks: ImportTaskSnapshot[] = [receipt];
    const dismissed: unknown[] = [];
    serve(() => tasks, (cmd, args) => { if (cmd === "plugin:library|dismiss_import") { dismissed.push(args); tasks = []; return null; } return undefined; });
    render(center());
    fireEvent.click(await within(panel()).findByRole("button", { name: "移除记录" }));
    await waitFor(() => expect(dismissed).toEqual([{ libraryId: "L1", taskId: "actual-task" }]));
    expect(screen.queryByRole("button", { name: "参考 / 未归类，导入完成" })).toBeNull();
    expect(trigger().querySelector(".k-import-dot")).toBeNull();
  });
});

describe("导入结束走轻提示（#388）", () => {
  it("结束时只发一条轻提示，回执不自己展开；“查看”打开弹层并展开它", async () => {
    serve([receipt]);
    render(<ToastProvider>{center()}</ToastProvider>);
    expect(await screen.findByText("1 个文件未导入", { selector: ".k-toast-title" })).toBeTruthy();
    expect(toastOf("1 个文件未导入").textContent).toContain("参考 / 未归类");
    expect(screen.queryByRole("dialog", { name: "导入" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看", hidden: true }));
    expect(await receiptRow()).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("1 个文件未导入", { selector: ".k-toast-title" })).toBeNull());
  });

  it("全部进来时是“导入完成”，写出数字，也带“查看”", async () => {
    serve([clean]);
    render(<ToastProvider>{center()}</ToastProvider>);
    await screen.findByText("导入完成", { selector: ".k-toast-title" });
    expect(toastOf("导入完成").textContent).toContain("新增 1");
    expect(within(toastOf("导入完成") as HTMLElement).getByRole("button", { name: "查看" })).toBeTruthy();
  });

  it("在弹层里展开这条回执时，它的结束提示一并收起", async () => {
    serve([clean]);
    render(<ToastProvider>{center()}</ToastProvider>);
    await screen.findByText("导入完成", { selector: ".k-toast-title" });
    fireEvent.click(within(panel()).getByRole("button", { name: "参考 / 未归类，导入完成" }));
    await waitFor(() => expect(document.querySelector(".k-toast")).toBeNull());
  });

  it("任务有警告（标签定义没存进图库）时提示以警告为题、不自动消失，回执里写出全文", async () => {
    serve([{ ...clean, warnings: ["标签定义没有存进图库，可在标签目录里重试"] }]);
    render(<ToastProvider>{center()}</ToastProvider>);
    expect(await screen.findByText("标签定义没有存进图库", { selector: ".k-toast-title" })).toBeTruthy();
    expect(toastOf("标签定义没有存进图库").getAttribute("data-tone")).toBe("warn");
    expect(trigger().querySelector(".k-import-dot")?.getAttribute("data-tone")).toBe("warn");
    fireEvent.click(screen.getByRole("button", { name: "查看", hidden: true }));
    expect(within(await receiptRow()).getByRole("note").textContent).toBe("标签定义没有存进图库，可在标签目录里重试");
  });

  it("“查看”展开提示所属的任务，即使之后开始了别的导入", async () => {
    const running: ImportTaskSnapshot = { ...receipt, taskId: "next-task", folderName: "人物", progress: { done: 1, total: 9 }, report: null };
    let calls = 0;
    serve(() => ++calls === 1 ? [clean] : [clean, running]);
    render(<ToastProvider>{center()}</ToastProvider>);
    await screen.findByText("导入完成", { selector: ".k-toast-title" });
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("正在导入"), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(await receiptRow()).toBeTruthy();
    expect(screen.getByRole("group", { name: "导入进度" }).textContent).toContain("参考 / 人物");
  });

  it("安全模式打开时，已显示的提示原地收起数字", async () => {
    serve([clean]);
    render(<ToastProvider>{center()}</ToastProvider>);
    await screen.findByText("导入完成", { selector: ".k-toast-title" });
    expect(toastOf("导入完成").textContent).toContain("新增 1");
    await act(() => emit("safe-mode-setting", true));
    await waitFor(() => expect(toastOf("导入完成").textContent).not.toMatch(/新增|已存在|更新/));
    expect(toastOf("导入完成").textContent).toContain("内容处理结果已保留");
    expect(screen.getAllByText("导入完成", { selector: ".k-toast-title" })).toHaveLength(1);
  });
});

describe("导入回执上下文撤销", () => {
  for (const [event, payload] of [["safe-mode-setting", true], ["workspace-changed", { revision: "after", libraries: [] }]] as const) {
    it(`${event} 隐去旧成功统计，并拒绝迟到的旧快照`, async () => {
      let calls = 0, release!: (value: ImportTaskSnapshot[]) => void;
      const pending = new Promise<ImportTaskSnapshot[]>(resolve => { release = resolve; });
      serve(() => { calls++; return calls === 1 ? [receipt] : pending; });
      render(center());
      fireEvent.click(await within(panel()).findByRole("button", { name: "参考 / 未归类，导入完成" }));
      const text = async () => (await receiptRow()).textContent;
      expect(await text()).toMatch(/已存在.*更新/);
      await waitFor(() => expect(calls).toBe(2));
      await act(() => emit(event, payload));
      expect(await text()).not.toMatch(/新增|已存在|更新/);
      expect(await text()).toContain("未导入1");
      await act(async () => { release([receipt]); await pending; });
      expect(await text()).not.toMatch(/新增|已存在|更新/);
      expect(await text()).toContain("未导入1");
    });
  }
});

it("另一个图库的任务回执移除后，不留下“正在导入”的空行，仍可开始导入（#98 本机 r14）", async () => {
  // 主窗口只按当前图库接收导入事件：导入到另一个图库时，它记下的“进行中”不会被结束事件清掉。
  const other = { ...clean, taskId: "other-library-task", destination: { libraryId: "L2", folderId: null }, libraryName: "另一个" };
  let tasks: ImportTaskSnapshot[] = [other];
  serve(() => tasks, (cmd) => { if (cmd === "plugin:library|dismiss_import") { tasks = []; return null; } return undefined; });
  render(center({ taskId: "other-library-task", progress: { done: 0, total: 0 } }));
  fireEvent.click(await within(panel()).findByRole("button", { name: "移除记录" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "另一个 / 未归类，导入完成" })).toBeNull());
  await new Promise(resolve => setTimeout(resolve, 900));
  expect(screen.queryByRole("group", { name: "导入进度" })).toBeNull();
  expect(trigger().getAttribute("aria-label")).toBe("导入");
  expect(within(panel()).getByRole("button", { name: /^图片/ })).toHaveProperty("disabled", false);
});

it("回执轮询碰上浏览结果变化时只重读，不在弹层里留下“浏览结果已变化”（#98 本机 r16）", async () => {
  let calls = 0;
  serve(() => { calls++; if (calls === 1) throw { code: "cursorExpired" }; return [receipt]; });
  render(center());
  await waitFor(() => expect(calls).toBeGreaterThan(2));
  const pop = panel();
  expect(pop.textContent).not.toContain("浏览结果已变化");
  expect(within(pop).queryByRole("alert")).toBeNull();
});

describe("导入任务轮询", () => {
  const poll = async (tasks: ImportTaskSnapshot[]) => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      serve(() => { calls++; return tasks; });
      render(center());
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      return calls;
    } finally { vi.useRealTimers(); }
  };

  it("有进行中的任务时每 400 ms 读一次进度", async () => {
    const running = { ...receipt, report: null, progress: { done: 1, total: 3 } };
    expect(await poll([running])).toBeGreaterThanOrEqual(20);
  });

  it.each([["没有任务", [] as ImportTaskSnapshot[]], ["只有已结束的回执", [receipt]]])("%s时逐渐放慢，不再每 400 ms 读一次", async (_, tasks) => {
    expect(await poll(tasks)).toBeLessThanOrEqual(8);
  });
});
