import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspaceSources } from "./WorkspacePane";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";

const card: WorkspaceCard = { id: "same-bytes", width: 100, height: 200, thumbnail: "A/a/256", adult: false, libraryId: "A", imageId: "a", sources: [
  { libraryId: "A", libraryName: "工作参考", imageId: "a", matches: true, unavailable: null, deleted: false },
  { libraryId: "B", libraryName: "移动盘参考", imageId: "b", matches: true, unavailable: null, deleted: false },
] };
afterEach(() => { cleanup(); clearMocks(); });

it("明确选择未活动来源后复用备注整理，发送完整来源身份", async () => {
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
  render(<WorkspaceSources card={card} onClose={vi.fn()} onView={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "整理此来源" })[1]);
  const note = await screen.findByRole("textbox", { name: "备注" });
  expect((note as HTMLTextAreaElement).value).toBe("B 的备注");
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
  render(<WorkspaceSources card={card} onClose={close} onView={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "整理此来源" })[0]);
  await screen.findByRole("textbox", { name: "备注" });
  fireEvent.click(screen.getByRole("button", { name: /^删除$/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "当前操作的来源记录" }), { target: { value: "B/b" } });
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
  render(<WorkspaceSources card={card} onClose={close} onView={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "整理此来源" })[0]);
  fireEvent.click(await screen.findByRole("button", { name: "永久删除…" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认永久删除" }));
  fireEvent.change(screen.getByRole("combobox", { name: "当前操作的来源记录" }), { target: { value: "B/b" } });
  await screen.findByRole("textbox", { name: "备注" });
  await import("@testing-library/react").then(({ act }) => act(async () => { finish(); await pending; }));
  expect(close).not.toHaveBeenCalled();
});
