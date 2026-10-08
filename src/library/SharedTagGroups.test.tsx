import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import { TagGroupsPane } from "./TagGroupsPane";
import { TagGroupBar } from "../search/TagGroupBar";
import { SettingsPanel } from "../SettingsPanel";
const blue = { id: "shared-blue", namespace: "general" as const, name: "蓝发", untranslated: false, hasExternal: true };
const purple = { ...blue, id: "shared-purple", name: "紫发" };
const groups: CatalogGroupView[] = [{ id: "G1", name: "发色", namespace: null,
  tags: [{ tag: blue, count: 1 }, { tag: purple, count: 1 }],
  sources: [{ libraryId: "A", libraryName: "角色参考", groupId: "old-group", groupName: "发色" }],
}, { id: "G2", name: "作品", namespace: "work", tags: [], sources: [] }];
afterEach(() => { cleanup(); clearMocks(); });
function backend(read: () => unknown = () => groups) {
  const calls: { cmd: string; args: unknown }[] = [];
  mockWindows("main");
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "plugin:library|shared_tag_groups" || cmd === "plugin:library|workspace_tag_groups") return read();
    if (cmd === "shell_settings") return { autostart: false, shortcuts: [], showApproxSource: false, forceSrgb: false, forceSrgbInEffect: false, usageLog: false };
    if (cmd === "plugin:library|safe_mode") return true;
    return null;
  }, { shouldMockEvents: true });
  return calls;
}
describe("T05 shared groups", () => {
  it("manages global groups without an active library and exposes migration provenance and sorting", async () => {
    const calls = backend(); const browse = vi.fn();
    render(<TagGroupsPane libraryId="" safe generation={0} onBrowse={browse} onError={vi.fn()} />);
    const group = await screen.findByRole("group", { name: "发色" });
    expect(within(group).getByText(/角色参考/)).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "发色（2 个标签）" }));
    expect(browse).toHaveBeenCalledWith(["shared-blue", "shared-purple"]);
    fireEvent.click(within(group).getByRole("button", { name: "下移标签分组“发色”" }));
    await act(async () => {});
    expect(calls.find((call) => call.cmd === "plugin:library|edit_shared_tag_group")?.args).toEqual({ edit: { kind: "orderGroups", groupIds: ["G2", "G1"] }, safeMode: true });
    expect(calls.some((call) => call.cmd === "plugin:library|tag_groups")).toBe(false);
  });
  it("renders global groups in settings with no current library", async () => {
    backend(); render(<SettingsPanel />);
    const settingsGroups = await screen.findByRole("region", { name: "全局标签分组" });
    expect(await within(settingsGroups).findByRole("group", { name: "发色" })).toBeTruthy();
  });
  it("does not show an old unsafe response after safe mode changes", async () => {
    let finish: (value: CatalogGroupView[]) => void = () => {};
    let reads = 0;
    backend(() => ++reads === 1 ? new Promise<CatalogGroupView[]>((resolve) => { finish = resolve; }) : []);
    const error = vi.fn(); const browse = vi.fn();
    const view = render(<TagGroupsPane libraryId="" safe={false} generation={0} onBrowse={browse} onError={error} />);
    await act(async () => {});
    view.rerender(<TagGroupsPane libraryId="" safe generation={1} onBrowse={browse} onError={error} />);
    await act(async () => { finish([{ ...groups[0], name: "旧视角", tags: [{ tag: { ...blue, name: "封印旧标签" }, count: 99 }] }]); });
    expect(screen.queryByText("封印旧标签")).toBeNull();
    expect(screen.queryByText("旧视角")).toBeNull();
  });
  it("the accepted popover can add a visible OR group condition", async () => {
    backend(); const change = vi.fn();
    render(<TagGroupBar workspace libraryId="" safe generation={0} input={{ conditions: [], exact: true }} onChange={change} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /发色/ }));
    fireEvent.click(screen.getByRole("button", { name: "按“发色”任一标签查找" }));
    expect(change).toHaveBeenCalledWith({ exact: true, conditions: [{ negate: false, any: [
      { kind: "tag", id: "shared-blue", dismissed: [] }, { kind: "tag", id: "shared-purple", dismissed: [] },
    ] }] });
  });
});
