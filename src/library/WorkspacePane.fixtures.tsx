import { afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, render, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspacePane } from "./WorkspacePane";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { BrowseScope } from "../bindings/BrowseScope";

// WorkspacePane 测试共用的数据与目录读取模拟。
export const names: Record<string, string> = { A: "人物参考", B: "风景参考" };
export const registrations = ["A", "B"].map((id) => ({ library: { id, name: names[id], root: `D:\\${id}\\参考` }, unavailable: null as string | null }));
export const forest = (revision = "r"): WorkspaceDirectories => ({ status: { revision, libraries: registrations }, providers: registrations.map((registration) => ({ registration: { ...registration, library: { ...registration.library } }, unassigned: 1, descendants: { [registration.library.id + "-root"]: 2, [registration.library.id + "-child"]: 1 }, sidebar: { all: 3, trash: 0, folders: [{ id: registration.library.id + "-root", name: "人物", count: 1, children: [{ id: registration.library.id + "-child", name: "动作", count: 1, children: [] }] }] } })) });
export let pending: { safeMode: boolean; resolve: (value: WorkspaceDirectories) => void; reject: (error: unknown) => void }[];
export const props = { status: { revision: "r", libraries: registrations }, scope: { kind: "all" } as WorkspaceScope, safeMode: true, reloadKey: 0, onScope: vi.fn(), onError: vi.fn() };
export const settle = () => act(async () => { await Promise.resolve(); });
export const section = (id: string) => document.querySelector<HTMLElement>(`[data-library-id="${id}"]`)!;
export const arrow = (id: string) => within(section(id)).getByRole("button", { name: new RegExp(`^(展开|收起)${names[id]}$`) });
export const expanded = (id: string) => arrow(id).getAttribute("aria-expanded") === "true";
export const inA = (local: BrowseScope): WorkspaceScope => ({ kind: "library", libraryId: "A", scope: local });
beforeEach(() => {
  pending = [];
  props.onScope.mockClear(); props.onError.mockClear();
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    throw new Error(command);
  });
});
afterEach(() => { vi.useRealTimers(); cleanup(); clearMocks(); });
export async function loaded(view = render(<WorkspacePane {...props} />), value = forest()) {
  await settle();
  await act(async () => pending.at(-1)!.resolve(value));
  return view;
}

