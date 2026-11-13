import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fakeBackend } from "../test/backend";
import { tipText } from "../test/tip";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import { TagGroupsPane } from "./TagGroupsPane";
import { SharedTagGroupsSettings } from "./SharedTagGroupsSettings";
import { emit } from "@tauri-apps/api/event";
import { TagGroupBar } from "../search/TagGroupBar";
import { SettingsPanel } from "../settings/SettingsPanel";
import { ToastProvider } from "../ui/Toast";
const blue = { id: "shared-blue", namespace: "general" as const, name: "蓝发", untranslated: false, hasExternal: true };
const purple = { ...blue, id: "shared-purple", name: "紫发" };
const groups: CatalogGroupView[] = [{ id: "G1", name: "发色", namespace: null,
  tags: [{ tag: blue, count: 1 }, { tag: purple, count: 1 }],
  sources: [{ libraryId: "A", libraryName: "角色参考", groupId: "old-group", groupName: "发色" }],
}, { id: "G2", name: "作品", namespace: "work", tags: [], sources: [] }];
function backend(read: () => unknown = () => groups) {
  return fakeBackend({
    shared_tag_groups: () => read(),
    workspace_tag_groups: () => read(),
    workspace_status: { revision: "R1", libraries: [] },
  });
}
describe("T05 shared groups", () => {
  it("manages global groups without an active library and exposes migration provenance and sorting", async () => {
    const fake = backend(); const browse = vi.fn();
    fake.on("edit_shared_tag_group", null);
    render(<ToastProvider><TagGroupsPane libraryId="" safe generation={0} onBrowse={browse} onError={vi.fn()} /></ToastProvider>);
    const group = await screen.findByRole("group", { name: "发色" });
    // 来源是次要信息：放在名称旁图标的悬停提示里（设计系统：次要信息收进悬停提示）。
    expect(await tipText(within(group).getByRole("img", { name: "来自：角色参考 / 发色" }))).toContain("来自：角色参考 / 发色");
    fireEvent.click(within(group).getByRole("button", { name: "发色（2 个标签）" }));
    expect(browse).toHaveBeenCalledWith(["shared-blue", "shared-purple"]);
    fireEvent.click(within(group).getByRole("button", { name: "下移标签分组“发色”" }));
    await act(async () => {});
    expect(fake.calls("edit_shared_tag_group")[0]?.args).toEqual({ edit: { kind: "orderGroups", groupIds: ["G2", "G1"] }, safeMode: true });
    expect(fake.calls("tag_groups")).toEqual([]);
  });
  it("renders global groups in settings with no current library", async () => {
    backend(); render(<SettingsPanel initialTab="tags" />); fireEvent.click(await screen.findByRole("button", { name: "分组" }));
    const settingsGroups = await screen.findByRole("region", { name: "标签分组" });
    expect(await within(settingsGroups).findByRole("group", { name: "发色" })).toBeTruthy();
  });
  it("keeps a settings rename draft when the monitor repeats the current revision", async () => {
    backend(); render(<ToastProvider><SharedTagGroupsSettings onError={vi.fn()} /></ToastProvider>);
    const group = await screen.findByRole("group", { name: "发色" });
    fireEvent.click(within(group).getByRole("button", { name: "重命名标签分组“发色”" }));
    fireEvent.change(screen.getByRole("textbox", { name: "标签分组名称" }), { target: { value: "正在整理" } });
    await act(async () => { await emit("workspace-changed", { revision: "R1", libraries: [] }); });
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "标签分组名称" }).value).toBe("正在整理");
  });
  it("does not show an old unsafe response after safe mode changes", async () => {
    let finish: (value: CatalogGroupView[]) => void = () => {};
    let reads = 0;
    backend(() => ++reads === 1 ? new Promise<CatalogGroupView[]>((resolve) => { finish = resolve; }) : []);
    const error = vi.fn(); const browse = vi.fn();
    const view = render(<ToastProvider><TagGroupsPane libraryId="" safe={false} generation={0} onBrowse={browse} onError={error} /></ToastProvider>);
    await act(async () => {});
    view.rerender(<ToastProvider><TagGroupsPane libraryId="" safe generation={1} onBrowse={browse} onError={error} /></ToastProvider>);
    await act(async () => { finish([{ ...groups[0], name: "旧视角", tags: [{ tag: { ...blue, name: "封印旧标签" }, count: 99 }] }]); });
    expect(screen.queryByText("封印旧标签")).toBeNull();
    expect(screen.queryByText("旧视角")).toBeNull();
  });
  it("undoing a group delete works after safe mode changed while the toast was shown", async () => {
    const fake = backend();
    fake.on("delete_shared_tag_group", { id: "G2", name: "作品", namespace: "work", ord: 1, members: [], migratedFrom: [] });
    fake.on("restore_shared_tag_group", null);
    const error = vi.fn();
    const view = render(<ToastProvider><TagGroupsPane libraryId="" safe={false} generation={0} onBrowse={vi.fn()} onError={error} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "删除标签分组“作品”" }));
    const undo = await screen.findByRole("button", { name: "撤销" });
    view.rerender(<ToastProvider><TagGroupsPane libraryId="" safe generation={1} onBrowse={vi.fn()} onError={error} /></ToastProvider>);
    fireEvent.click(undo);
    await waitFor(() => expect(fake.calls("restore_shared_tag_group")).not.toEqual([]));
    const restore = fake.calls("restore_shared_tag_group")[0]!;
    expect(restore.args).not.toHaveProperty("safeMode");
    expect(error).not.toHaveBeenCalled();
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
  it("安全模式刚切换（LensChanged）时读分组不报错：确认后会按新视角重读（#176）", async () => {
    backend(() => Promise.reject({ code: "lensChanged" }));
    const barError = vi.fn(), paneError = vi.fn();
    render(<TagGroupBar workspace libraryId="" safe generation={0} input={{ conditions: [], exact: true }} onChange={vi.fn()} onError={barError} />);
    render(<ToastProvider><TagGroupsPane libraryId="" safe generation={0} onBrowse={vi.fn()} onError={paneError} /></ToastProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(barError).not.toHaveBeenCalled();
    expect(paneError).not.toHaveBeenCalled();
  });
});
