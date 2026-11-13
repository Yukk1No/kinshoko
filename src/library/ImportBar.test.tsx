import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Channel } from "@tauri-apps/api/core";
import type { ImportReport } from "../bindings/ImportReport";
import { createRef } from "react";
import { fakeBackend } from "../test/backend";
import { ImportBar, type ImportActions } from "./ImportBar";

const report: ImportReport = {
  items: [],
  cancelled: false,
  fromEagle: false,
  eagleMissing: 0,
  eagleRelocations: [],
  sealedDuplicates: false,
  privateSummary: false,
  trashDuplicates: false,
};

function backend() {
  fakeBackend({
    discover_eagle_libraries: [
      { name: "主库", path: "D:/Eagle/主库.library", items: 3, version: "4.0.0", foundBy: "settings" },
    ],
    start_import: "task-1",
    eagle_tag_mapping: { matched: [], unmatched: [], vocabularySize: 0 },
  });
}

/** 导入入口在顶栏的分体按钮里（#98），它经 `actionsRef` 调用导入栏；测试同样经它调用。 */
const actions = createRef<ImportActions>() as { current: ImportActions | null };
const fromEagle = () =>
  act(() => {
    actions.current!.eagle();
  });

/** 结束的通知带“查看”，点了才打开回执卡。 */
const openReceipt = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "查看" }));
  return screen.findByRole("region", { name: "导入结果" });
};

function bar(props: { report: ImportReport | null }) {
  // 测试里启动命令总是返回 task-1，结束的也是它。
  const finished = props.report && { taskId: "task-1", report: props.report };
  return (
    <ImportBar
      actionsRef={actions}
      enabled
      libraryId="L1"
      libraryName="参考"
      running={null}
      finished={finished}
      onStarted={() => {}}
      onDismissReport={() => {}}
    />
  );
}

describe("导入栏：Eagle 迁入后的标签外部对应", () => {
  it("通用入口被后端识别为 Eagle 时，也进入标签对应步骤且只打开一次", async () => {
    backend();
    const { rerender } = render(bar({ report: null }));
    const detected = { ...report, fromEagle: true };
    rerender(bar({ report: detected }));
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    rerender(bar({ report: { ...detected } }));
    expect(screen.queryByRole("region", { name: "标签的外部对应" })).toBeNull();
  });

  it("从 Eagle 迁入完成后进入“标签的外部对应”一步", async () => {
    backend();
    const { rerender } = render(bar({ report: null }));
    await fromEagle();
    fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
    const plan = await screen.findByRole("dialog", { name: "从 Eagle 导入" });
    expect((await screen.findByRole<HTMLInputElement>("radio", { name: /继续跳过/ })).checked).toBe(true);
    fireEvent.click(within(plan).getByRole("button", { name: "开始导入" }));
    // 迁入开始后选择资料库的面板收起。
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "从 Eagle 导入" })).toBeNull());
    rerender(bar({ report }));

    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
  });

  it("开始导入后对话框连同遮罩一起关闭，窗口仍可点按（#98 本机 r12）", async () => {
    backend();
    render(bar({ report: null }));
    await fromEagle();
    fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
    const plan = await screen.findByRole("dialog", { name: "从 Eagle 导入" });
    fireEvent.click(within(plan).getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "从 Eagle 导入" })).toBeNull());
    // 留下的遮罩会盖住整个窗口、吃掉所有点按。
    await waitFor(() => expect(document.querySelector(".k-backdrop")).toBeNull());
  });

  it("普通导入完成后不显示这一步", async () => {
    backend();
    const { rerender } = render(bar({ report: null }));
    rerender(bar({ report }));
    await screen.findByText("导入完成");
    expect(screen.queryByRole("region", { name: "标签的外部对应" })).toBeNull();
  });
});

describe("封印重复项回执", () => {
  it("默认只提示存在封印重复项，不显示成功项数量或内容", async () => {
    backend();
    render(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
    expect(await screen.findByText("有封印项重复，是否展开看看")).toBeTruthy();
    expect(screen.queryByText(/新增.*张/)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(await screen.findByRole("button", { name: "展开" })).toBeTruthy();
  });
});

it("关闭期间迟到的预览字节不会创建图片，且回执仍需重新明确展开", async () => {
  let release!: () => void, channel: Channel<ArrayBuffer> | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeBackend({
    open_import_preview: { id: "receipt-session", items: ["opaque-item"] },
    read_import_preview: (args) => {
      channel = args.onChunk as Channel<ArrayBuffer>;
      return pending;
    },
    close_import_preview: null,
  });
  const calls = () => fake.calls().map((call) => call.command);
  const create = vi.fn(() => "blob:preview");
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const { rerender } = render(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
  fireEvent.click(await screen.findByRole("button", { name: "展开" }));
  await waitFor(() => expect(calls()).toContain("read_import_preview"));
  fireEvent.click(screen.getByRole("button", { name: "关闭重复项预览" }));
  await waitFor(() => expect(calls()).toContain("close_import_preview"));
  channel!.onmessage(new Uint8Array([137, 80, 78, 71]).buffer);
  channel!.onmessage(new ArrayBuffer(0));
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
  rerender(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
  expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
  vi.unstubAllGlobals();
});

it("展开后是界面系统的对话框：标题用规格原话，关闭按钮可用", async () => {
  fakeBackend({
    open_import_preview: { id: "session", items: [] },
    close_import_preview: null,
  });
  render(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
  fireEvent.click(await screen.findByRole("button", { name: "展开" }));
  const dialog = await screen.findByRole("dialog", { name: "本次封印重复项" });
  expect(dialog.className).toContain("k-dialog");
  expect(dialog.tagName).not.toBe("DIALOG");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭重复项预览" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull());
});

it("切换到另一张回执不会自动沿用前一张回执的明确同意", async () => {
  const opened: string[] = [];
  fakeBackend({
    open_import_preview: (args) => {
      opened.push(args.taskId as string);
      return { id: "session", items: [] };
    },
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const receiptBar = (taskId: string) => (
    <ImportBar
      enabled
      libraryId="L1"
      libraryName="参考"
      running={null}
      finished={{ taskId, report: { ...report, sealedDuplicates: true, privateSummary: true } }}
      onStarted={() => {}}
      onDismissReport={() => {}}
    />
  );
  const { rerender } = render(receiptBar("task-first"));
  fireEvent.click(await screen.findByRole("button", { name: "展开" }));
  await waitFor(() => expect(opened).toEqual(["task-first"]));
  rerender(receiptBar("task-next"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toEqual(["task-first"]);
  expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
});

describe("导入对话框与右下角卡片（#98）", () => {
  it("Eagle 的删过的图默认继续跳过，选“这次也导入”只对这次任务生效", async () => {
    const started: unknown[] = [];
    fakeBackend({
      discover_eagle_libraries: [
        { name: "主库", path: "D:/Eagle/主库.library", items: 3, version: "4.0.0", foundBy: "settings" },
      ],
      start_import: (args) => {
        started.push(args);
        return "task-1";
      },
    });
    render(bar({ report: null }));
    await fromEagle();
    fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
    const plan = await screen.findByRole("dialog", { name: "从 Eagle 导入" });
    const skip = within(plan).getByRole<HTMLInputElement>("radio", { name: /继续跳过.*之前删掉的不再导入/ });
    const once = within(plan).getByRole<HTMLInputElement>("radio", { name: /这次也导入.*只对这一次有效/ });
    expect(skip.checked).toBe(true);
    fireEvent.click(once);
    expect(once.checked).toBe(true);
    fireEvent.click(within(plan).getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ options: { eagleDeletedContent: "allowThisImport" } });
  });

  it("进度卡显示保存位置与进度，可以后台进行，再从导入菜单找回", async () => {
    backend();
    const actions = { current: null as null | { showTasks: () => void } };
    const view = () => (
      <ImportBar
        enabled
        libraryId="L1"
        libraryName="参考"
        ownerLabel="参考 / 人物"
        running={{ taskId: "task-1", progress: { done: 12, total: 38 } }}
        finished={null}
        onStarted={() => {}}
        onDismissReport={() => {}}
        actionsRef={actions as never}
      />
    );
    const { rerender } = render(view());
    const card = await screen.findByRole("region", { name: "导入进度" });
    expect(within(card).getByText("放到 参考 / 人物")).toBeTruthy();
    expect(within(card).getByText("12 / 38")).toBeTruthy();
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("12");
    expect(within(card).getByRole("button", { name: "取消导入" }).textContent).toBe("取消");
    fireEvent.click(within(card).getByRole("button", { name: "后台进行" }));
    expect(screen.queryByRole("region", { name: "导入进度" })).toBeNull();
    rerender(view());
    expect(screen.queryByRole("region", { name: "导入进度" })).toBeNull();
    await act(async () => actions.current!.showTasks());
    expect(screen.getByRole("region", { name: "导入进度" })).toBeTruthy();
  });

  it("结果卡列出新增、已存在与失败，重试只针对读取失败的项", async () => {
    backend();
    const finished = {
      taskId: "task-1",
      report: {
        ...report,
        items: [
          { path: "a.png", outcome: { kind: "imported", imageId: "a" } },
          { path: "b.png", outcome: { kind: "merged", imageId: "b" } },
          { path: "c.txt", outcome: { kind: "unsupported" } },
          { path: "d.png", outcome: { kind: "readFailed", reason: { code: "system", detail: "被占用" } } },
        ],
      },
    } as never;
    render(
      <ImportBar
        enabled
        libraryId="L1"
        libraryName="参考"
        running={null}
        finished={finished}
        onStarted={() => {}}
        onDismissReport={() => {}}
      />,
    );
    const card = await openReceipt();
    expect(card.textContent).toContain("新增 1");
    expect(card.textContent).toContain("已存在 1");
    expect(card.textContent).not.toContain("没导入");
    expect(within(card).queryByText("未导入的文件")).toBeNull();
    const rejected = within(card).getByRole("button", { name: "未导入 2 张" });
    expect(rejected.getAttribute("aria-expanded")).toBe("false");
    expect(within(card).queryByText("读取失败：被占用")).toBeNull();
    fireEvent.click(rejected);
    expect(rejected.getAttribute("aria-expanded")).toBe("true");
    expect(within(card).getByText("读取失败：被占用")).toBeTruthy();
    expect(within(card).getByText("c.txt")).toBeTruthy();
    fireEvent.click(rejected);
    expect(within(card).queryByText("读取失败：被占用")).toBeNull();
    expect(within(card).getByRole("button", { name: "重试失败的 1 项" }).textContent).toBe("重试失败");
  });

  it("全部导入成功时没有未导入这一行，也就没有可点开的东西", async () => {
    backend();
    const finished = {
      taskId: "task-1",
      report: { ...report, items: [{ path: "a.png", outcome: { kind: "imported", imageId: "a" } }] },
    } as never;
    render(
      <ImportBar
        enabled
        libraryId="L1"
        libraryName="参考"
        running={null}
        finished={finished}
        onStarted={() => {}}
        onDismissReport={() => {}}
      />,
    );
    const title = await screen.findByText("导入完成");
    expect(title.closest(".k-toast")?.textContent).not.toContain("未导入");
    expect(screen.queryByRole("button", { name: "查看" })).toBeNull();
  });

  it("换一个任务的回执时收起未导入的文件", async () => {
    backend();
    const failing = (taskId: string, path: string) =>
      ({ taskId, report: { ...report, items: [{ path, outcome: { kind: "unsupported" } }] } }) as never;
    const ui = (finished: never) => (
      <ImportBar
        enabled
        libraryId="L1"
        libraryName="参考"
        running={null}
        finished={finished}
        onStarted={() => {}}
        onDismissReport={() => {}}
      />
    );
    const view = render(ui(failing("task-1", "a.txt")));
    fireEvent.click(within(await openReceipt()).getByRole("button", { name: "未导入 1 张" }));
    expect(screen.getByText("a.txt")).toBeTruthy();
    view.rerender(ui(failing("task-2", "b.txt")));
    expect((await screen.findByRole("button", { name: "未导入 1 张" })).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("b.txt")).toBeNull();
  });
});
