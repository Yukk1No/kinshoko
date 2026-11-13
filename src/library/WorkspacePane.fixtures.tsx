import { afterEach, beforeEach, vi } from "vitest";
import { act, render, within } from "@testing-library/react";
import { type Args, fakeBackend } from "../test/backend";
import { WorkspacePane } from "./WorkspacePane";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { BrowseScope } from "../bindings/BrowseScope";

// WorkspacePane 测试共用的数据与目录读取模拟。
export const names: Record<string, string> = { A: "人物参考", B: "风景参考" };
export const registrations = ["A", "B"].map((id) => ({ library: { id, name: names[id], root: `D:\\${id}\\参考` }, unavailable: null as import("../bindings/CommandError").CommandError | null }));
export const forest = (revision = "r"): WorkspaceDirectories => ({ status: { revision, libraries: registrations }, registrationOrder: ["A", "B"], providers: registrations.map((registration) => ({ registration: { ...registration, library: { ...registration.library } }, unassigned: 1, descendants: { [registration.library.id + "-root"]: 2, [registration.library.id + "-child"]: 1 }, sidebar: { all: 3, trash: 0, folders: [{ id: registration.library.id + "-root", name: "人物", count: 1, children: [{ id: registration.library.id + "-child", name: "动作", count: 1, children: [] }] }] } })) });
export let pending: { safeMode: boolean; resolve: (value: WorkspaceDirectories) => void; reject: (error: unknown) => void }[];
export const props = { status: { revision: "r", libraries: registrations }, scope: { kind: "all" } as WorkspaceScope, safeMode: true, reloadKey: 0, onScope: vi.fn(), onError: vi.fn() };
export const settle = () => act(async () => { await Promise.resolve(); });
export const section = (id: string) => document.querySelector<HTMLElement>(`[data-library-id="${id}"]`)!;
export const arrow = (id: string) => within(section(id)).getByRole("button", { name: new RegExp(`^(展开|收起)${names[id]}$`) });
export const expanded = (id: string) => arrow(id).getAttribute("aria-expanded") === "true";
export const inA = (local: BrowseScope): WorkspaceScope => ({ kind: "library", libraryId: "A", scope: local });
/** 目录读取的回答：留在 `pending` 里，由测试放出。 */
export const directories = (args: Args) => new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: args.safeMode as boolean, resolve, reject }));
beforeEach(() => {
  pending = [];
  props.onScope.mockClear(); props.onError.mockClear();
  fakeBackend({ workspace_directories: directories });
});
afterEach(() => { vi.useRealTimers(); });
export async function loaded(view = render(<WorkspacePane {...props} />), value = forest()) {
  await settle();
  await act(async () => pending.at(-1)!.resolve(value));
  return view;
}

