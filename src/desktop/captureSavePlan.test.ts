import { describe, expect, it } from "vitest";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import { chooseDestination, draftCaptureSave, prepareSave } from "./captureSavePlan";

// 存参考组前每张截图的去处（#320）：草稿只经 chooseDestination 改，只有核对通过才得到交给保存入口的计划。
const entry = (id: string, collected: string[] = []): CaptureEntry =>
  ({ id, width: 10, height: 10, createdAt: 0, pinned: true, collected: collected.map((libraryId) => ({ libraryId })) }) as CaptureEntry;
const registration = (id: string, unavailable: string | null = null): LibraryRegistration =>
  ({ library: { id, name: id, root: `D:/${id}` }, unavailable }) as LibraryRegistration;
const provider = (id: string, folders: string[]): WorkspaceDirectory => ({
  registration: registration(id),
  sidebar: { all: 0, trash: 0, folders: folders.map((f) => ({ id: f, name: f, children: [], count: 0 })) },
  unassigned: 0,
  descendants: {},
} as unknown as WorkspaceDirectory);
const providers = [provider("lib-a", ["folder-a"]), provider("lib-b", ["folder-b"])];
const target = { name: "头发参考" };

describe("captureSavePlan", () => {
  it("没选去处的截图不能形成计划", () => {
    const draft = draftCaptureSave(target, [entry("c1"), entry("c2")], []);
    const ready = chooseDestination(draft, "c1", { kind: "skip" });
    expect(prepareSave(ready, providers)).toEqual({ ok: false, problems: [{ captureId: "c2", reason: "unselected" }] });
  });

  it("三种去处交给保存入口的选择与原来一致", () => {
    let draft = draftCaptureSave(target, [entry("c1"), entry("c2"), entry("c3")], []);
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: null } });
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: "folder-a" } });
    draft = chooseDestination(draft, "c2", { kind: "keepInGroup" });
    draft = chooseDestination(draft, "c3", { kind: "skip" });
    const prepared = prepareSave(draft, providers);
    expect(prepared.ok && prepared.plan.target).toBe(target);
    expect(prepared.ok && prepared.plan.choices).toEqual([
      { captureId: "c1", libraryId: "lib-a", folderId: "folder-a" },
      { captureId: "c2", libraryId: null, folderId: null, keepInGroup: true },
      { captureId: "c3", libraryId: null, folderId: null },
    ]);
  });

  it("换图库时文件夹回到未归类，不沿用另一个库的文件夹", () => {
    let draft = draftCaptureSave(target, [entry("c1")], []);
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: null } });
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: "folder-a" } });
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-b", folderId: "folder-a" } });
    expect(draft.destinations.c1).toEqual({ kind: "collect", destination: { libraryId: "lib-b", folderId: null } });
  });

  it("选了图库又改成只存参考组时不留下文件夹", () => {
    let draft = draftCaptureSave(target, [entry("c1")], []);
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: null } });
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: "folder-a" } });
    draft = chooseDestination(draft, "c1", { kind: "keepInGroup" });
    const prepared = prepareSave(draft, providers);
    expect(prepared.ok && prepared.plan.choices).toEqual([{ captureId: "c1", libraryId: null, folderId: null, keepInGroup: true }]);
  });

  it("保存目标消失时阻止保存并指出是哪张", () => {
    let draft = draftCaptureSave(target, [entry("c1"), entry("c2")], []);
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: null } });
    draft = chooseDestination(draft, "c1", { kind: "collect", destination: { libraryId: "lib-a", folderId: "folder-a" } });
    draft = chooseDestination(draft, "c2", { kind: "collect", destination: { libraryId: "lib-b", folderId: null } });
    expect(prepareSave(draft, [provider("lib-a", []), provider("lib-b", [])])).toEqual({ ok: false, problems: [{ captureId: "c1", reason: "unavailable" }] });
    expect(prepareSave(draft, [provider("lib-a", ["folder-a"])])).toEqual({ ok: false, problems: [{ captureId: "c2", reason: "unavailable" }] });
  });

  it("只收藏进一个连着的图库的截图预选收藏回那里", () => {
    const draft = draftCaptureSave(target, [entry("c1", ["lib-a"]), entry("c2", ["lib-b"]), entry("c3", ["lib-a", "lib-b"]), entry("c4")],
      [registration("lib-a"), registration("lib-b", "没插")]);
    expect(draft.destinations).toEqual({
      c1: { kind: "collect", destination: { libraryId: "lib-a", folderId: null } },
      c2: { kind: "unselected" },
      c3: { kind: "unselected" },
      c4: { kind: "unselected" },
    });
  });
});
