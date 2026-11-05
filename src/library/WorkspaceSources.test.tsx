import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspaceSources } from "./WorkspacePane";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";

const card: WorkspaceCard = { id: "same-bytes", width: 100, height: 200, adult: false, libraryId: "A", imageId: "a", sources: [
  { libraryId: "A", libraryName: "工作参考", imageId: "a", matches: true, unavailable: null, deleted: false },
  { libraryId: "B", libraryName: "移动盘参考", imageId: "b", matches: true, unavailable: null, deleted: false },
] };
afterEach(() => { cleanup(); clearMocks(); });

/** 一份来源的读取（#424）：详情与标签；不属于它们的命令回 undefined。 */
function sourceReads(cmd: string, args: unknown, detail: (id: string) => object = () => ({})) {
  const id = (args as { imageId: string }).imageId;
  if (cmd === "plugin:library|image") return { id, originalName: id + ".png", width: 100, height: 200, folders: [], note: { manual: id + " 的备注", sources: [] }, collectedAt: 0, sourceLinks: [], deletedAt: null, rating: { imageId: id, suggested: null, manual: null, effective: null }, versions: { previous: null, newer: [] }, ...detail(id) };
  if (cmd === "plugin:library|catalog_image_tags") return { image: { imageId: id, tags: [], rejected: [] }, identities: [] };
  return undefined;
}

it("切到另一份后，备注按（资料库，图）只写那一份", async () => {
  const edits: unknown[] = [];
  mockIPC((cmd, args) => {
    const read = sourceReads(cmd, args, (id) => ({ note: { manual: id === "b" ? "B 的备注" : "A 的备注", sources: [] } }));
    if (read) return read;
    if (cmd === "plugin:desktop|reference_groups") return [];
    if (cmd === "plugin:library|edit") { edits.push(args); return []; }
  });
  render(<WorkspaceSources card={card} onClose={vi.fn()} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(within(screen.getByRole("group", { name: "所在图库" })).getByRole("button", { name: "移动盘参考" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("B 的备注"));
  const note = screen.getByRole("textbox", { name: "备注" });
  fireEvent.change(note, { target: { value: "只改 B" } });
  fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
  await waitFor(() => expect(edits).toEqual([{ libraryId: "B", ids: ["b"], edits: [{ kind: "setNote", text: "只改 B" }] }]));
});

it("换到 B 后，A 迟到的分级响应不能关闭 B 的面板", async () => {
  let finish!: (details: unknown[]) => void;
  const pending = new Promise<unknown[]>((resolve) => { finish = resolve; });
  mockIPC((cmd, args) => {
    const read = sourceReads(cmd, args);
    if (read) return read;
    if (cmd === "plugin:library|edit") return pending;
  });
  const close = vi.fn();
  render(<WorkspaceSources card={card} onClose={close} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(screen.getByRole("button", { name: "成人" }));
  fireEvent.click(within(screen.getByRole("group", { name: "所在图库" })).getByRole("button", { name: "移动盘参考" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("b 的备注"));
  await act(async () => {
    finish([sourceReads("plugin:library|image", { imageId: "a" }, () => ({ rating: { imageId: "a", suggested: null, manual: "explicit", effective: "explicit" } }))]);
    await pending;
  });
  expect(close).not.toHaveBeenCalled();
});

it("安全模式下把这一份改成成人分级，面板随之关闭", async () => {
  mockIPC((cmd, args) => {
    const read = sourceReads(cmd, args);
    if (read) return read;
    if (cmd === "plugin:library|edit") return [sourceReads("plugin:library|image", { imageId: "a" }, () => ({ rating: { imageId: "a", suggested: null, manual: "explicit", effective: "explicit" } }))];
  });
  const close = vi.fn();
  render(<WorkspaceSources card={card} onClose={close} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(screen.getByRole("button", { name: "成人" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
});

it("同名图库在切换按钮的提示里显示最短独立路径", () => {
  const sameNames = { ...card, sources: card.sources.map((source) => ({ ...source, libraryName: "同名资料库" })) };
  mockIPC(() => new Promise(() => {}));
  render(<WorkspaceSources card={sameNames} onClose={vi.fn()} registrations={[
    { library: { id: "A", name: "同名资料库", root: "C:\\common\\first\\Art" }, unavailable: null },
    { library: { id: "B", name: "同名资料库", root: "C:\\common\\second\\Art" }, unavailable: null },
  ]} />);
  const [a, b] = within(screen.getByRole("group", { name: "所在图库" })).getAllByRole("button");
  expect(a.getAttribute("title")).toBe("…\\first\\Art");
  expect(b.getAttribute("title")).toBe("…\\second\\Art");
});

it("只在一个图库的图直接显示详情，没有图库切换", async () => {
  mockIPC((cmd, args) => sourceReads(cmd, args, () => ({ originalName: "only.png" })));
  render(<WorkspaceSources card={{ ...card, sources: card.sources.slice(0, 1) }} onClose={vi.fn()} />);
  await screen.findByText("only.png");
  expect(screen.queryByRole("group", { name: "所在图库" })).toBeNull();
});

it("卡片代表的那份未连接时，先打开另一份可用的", async () => {
  const inspected: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|image") inspected.push((args as { libraryId: string }).libraryId);
    return new Promise(() => {});
  });
  const offline: WorkspaceCard = { ...card, sources: [{ ...card.sources[0], unavailable: { code: "system", detail: "离线" } }, card.sources[1]] };
  render(<WorkspaceSources card={offline} onClose={vi.fn()} />);
  await waitFor(() => expect(inspected).toEqual(["B"]));
});

it("来源读不出来时只留原因，收起面板", async () => {
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|image") return Promise.reject({ code: "unknownImage" });
    return sourceReads(cmd, args);
  });
  render(<WorkspaceSources card={{ ...card, sources: card.sources.slice(0, 1) }} onClose={vi.fn()} />);
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  expect(screen.queryByRole("textbox", { name: "备注" })).toBeNull();
});

it("和普通单选面板一样：没有操作栏，文件夹标签不能移出", async () => {
  mockIPC((cmd, args) => sourceReads(cmd, args, () => ({ deletedAt: 1, folders: [{ id: "f", name: "人物" }] })));
  render(<WorkspaceSources card={card} onClose={vi.fn()} />);
  await screen.findByText("人物");
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(screen.queryByText("已选 1 张")).toBeNull();
  for (const name of ["移到文件夹", "移到回收站", "恢复", "永久删除…", "取消选择", "移出「人物」", "复制到…"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
});
