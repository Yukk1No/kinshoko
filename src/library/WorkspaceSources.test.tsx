import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspaceSources } from "./WorkspacePane";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";

const card: WorkspaceCard = { id: "same-bytes", width: 100, height: 200, adult: false, libraryId: "A", imageId: "a", sources: [
  { libraryId: "A", libraryName: "工作参考", imageId: "a", matches: true, unavailable: null, deleted: false },
  { libraryId: "B", libraryName: "移动盘参考", imageId: "b", matches: true, unavailable: null, deleted: false },
] };
afterEach(() => { cleanup(); clearMocks(); });

it("在图库间切换后复用备注整理，发送完整来源身份", async () => {
  const edits: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|workspace_source_inspection") return {
      detail: { id: "b", originalName: "same.png", width: 100, height: 200, folders: [], note: { manual: "B 的备注", sources: [] }, collectedAt: 0, sourceLinks: [], deletedAt: null, rating: { imageId: "b", suggested: null, manual: null, effective: null }, versions: { previous: null, newer: [] } },
      tags: { image: { tags: [], rejected: [] }, identities: [] }, sidebar: { all: 1, trash: 0, folders: [] },
    };
    if (cmd === "plugin:library|workspace_sidebar") return { all: 1, trash: 0, folders: [] };
    if (cmd === "plugin:desktop|reference_groups") return [];
    if (cmd === "plugin:library|workspace_edit_source") { edits.push(args); return; }
  });
  render(<WorkspaceSources card={card} onClose={vi.fn()} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(within(screen.getByRole("group", { name: "所在图库" })).getByRole("button", { name: "移动盘参考" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("B 的备注"));
  const note = screen.getByRole("textbox", { name: "备注" });
  fireEvent.change(note, { target: { value: "只改 B" } });
  fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
  await waitFor(() => expect(edits).toEqual([{ target: { libraryId: "B", imageId: "b", contentId: "same-bytes" }, safeMode: true, edits: [{ kind: "setNote", text: "只改 B" }] }]));
});

it("换到 B 后，A 的迟到删除响应不能关闭 B 的整理面板", async () => {
  let finishDelete!: () => void;
  const deletion = new Promise<void>((resolve) => { finishDelete = resolve; });
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|workspace_source_inspection") {
      const id = (args as { target: { imageId: string } }).target.imageId;
      return { detail: { id, originalName: id + ".png", width: 100, height: 200, folders: [], note: { manual: id + " 的备注", sources: [] }, collectedAt: 0, sourceLinks: [], deletedAt: null, rating: { imageId: id, suggested: null, manual: null, effective: null }, versions: { previous: null, newer: [] } }, tags: { image: { tags: [], rejected: [] }, identities: [] }, sidebar: { all: 1, trash: 0, folders: [] } };
    }
    if (cmd === "plugin:library|workspace_sidebar") return { all: 1, trash: 0, folders: [] };
    if (cmd === "plugin:desktop|reference_groups") return [];
    if (cmd === "plugin:library|workspace_edit_source") return deletion;
  });
  const close = vi.fn();
  render(<WorkspaceSources card={card} onClose={close} />);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(screen.getByRole("button", { name: /^删除$/ }));
  fireEvent.click(within(screen.getByRole("group", { name: "所在图库" })).getByRole("button", { name: "移动盘参考" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "备注" }) as HTMLTextAreaElement).value).toBe("b 的备注"));
  await import("@testing-library/react").then(({ act }) => act(async () => { finishDelete(); await deletion; }));
  expect(close).not.toHaveBeenCalled();
});

it("换来源后，旧永久删除的迟到响应不能关闭新来源", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|workspace_source_inspection") {
      const id = (args as { target: { imageId: string } }).target.imageId;
      return { detail: { id, originalName: id + ".png", width: 100, height: 200, folders: [], note: { manual: id + " 的备注", sources: [] }, collectedAt: 0, sourceLinks: [], deletedAt: 1, rating: { imageId: id, suggested: null, manual: null, effective: null }, versions: { previous: null, newer: [] } }, tags: { image: { tags: [], rejected: [] }, identities: [] }, sidebar: { all: 0, trash: 1, folders: [] } };
    }
    if (cmd === "plugin:library|workspace_sidebar") return { all: 0, trash: 1, folders: [] };
    if (cmd === "plugin:desktop|reference_groups") return [];
    if (cmd === "plugin:library|workspace_preview_source_delete") return { imageIds: ["a"], groups: [], token: "preview-a" };
    if (cmd === "plugin:library|workspace_permanent_source_delete") return pending;
  });
  const close = vi.fn();
  render(<WorkspaceSources card={card} onClose={close} />);
  fireEvent.click(await screen.findByRole("button", { name: "永久删除…" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认永久删除" }));
  // 确认是模态提醒对话框，背后的来源切换对读屏隐藏；这里直接派发点击，模拟删除进行中来源被换掉的竞态。
  fireEvent.click(within(screen.getByRole("group", { name: "所在图库", hidden: true })).getByRole("button", { name: "移动盘参考", hidden: true }));
  await screen.findByRole("textbox", { name: "备注" });
  await import("@testing-library/react").then(({ act }) => act(async () => { finish(); await pending; }));
  expect(close).not.toHaveBeenCalled();
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
  mockIPC((cmd) => {
    if (cmd === "plugin:library|workspace_source_inspection") return {
      detail: { id: "a", originalName: "only.png", width: 100, height: 200, folders: [], note: { manual: null, sources: [] }, collectedAt: 0, sourceLinks: [], deletedAt: null, rating: { imageId: "a", suggested: null, manual: null, effective: null }, versions: { previous: null, newer: [] } },
      tags: { image: { tags: [], rejected: [] }, identities: [] }, sidebar: { all: 1, trash: 0, folders: [] },
    };
  });
  render(<WorkspaceSources card={{ ...card, sources: card.sources.slice(0, 1) }} onClose={vi.fn()} />);
  await screen.findByText("only.png");
  expect(screen.queryByRole("group", { name: "所在图库" })).toBeNull();
});

it("卡片代表的那份未连接时，先打开另一份可用的", async () => {
  const inspected: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|workspace_source_inspection") { inspected.push((args as { target: { libraryId: string } }).target.libraryId); return new Promise(() => {}); }
  });
  const offline: WorkspaceCard = { ...card, sources: [{ ...card.sources[0], unavailable: { code: "system", detail: "离线" } }, card.sources[1]] };
  render(<WorkspaceSources card={offline} onClose={vi.fn()} />);
  await waitFor(() => expect(inspected).toEqual(["B"]));
});
