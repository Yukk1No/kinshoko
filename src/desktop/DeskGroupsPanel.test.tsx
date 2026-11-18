import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskLists } from "../bindings/DeskLists";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";

// 参考组改成桌面后的侧栏面板（#592）。IPC 用替身；整桌换钉图的效果见 #591 的真机检查。
const ipc = vi.hoisted(() => ({
  lists: vi.fn(),
  changed: [] as Array<() => void>,
  groups: vi.fn(() => Promise.resolve([])),
  group: vi.fn(),
  switchTo: vi.fn(() => Promise.resolve()),
  newDesk: vi.fn(() => Promise.resolve()),
  archive: vi.fn(() => Promise.resolve()),
  unarchive: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  remove: vi.fn((id: string) => Promise.resolve({ groupId: id, name: id, unlinkedPins: [] })),
  restore: vi.fn(() => Promise.resolve()),
  purge: vi.fn(() => Promise.resolve()),
  removeMember: vi.fn(() => Promise.resolve()),
  exportPackage: vi.fn((): Promise<string | null> => Promise.resolve("D:/导出/头发.kinshoko-group")),
  importPackage: vi.fn(() => Promise.resolve({ name: "别人的参考组" } as unknown)),
}));

vi.mock("../ipc", () => ({
  saveMemory: () => Promise.resolve({ importDestination: null, newLibraryParent: null }),
  deskReferenceGroups: ipc.lists,
  referenceGroups: ipc.groups,
  referenceGroup: ipc.group,
  groupSaveCaptures: () => Promise.resolve([]),
  captureUrl: (id: string) => `capture://${id}`,
  thumbnailUrl: (address: string) => `thumb://${address}`,
  switchReferenceGroup: ipc.switchTo,
  newReferenceDesk: ipc.newDesk,
  archiveReferenceGroup: ipc.archive,
  unarchiveReferenceGroup: ipc.unarchive,
  renameReferenceGroup: ipc.rename,
  deleteReferenceGroup: ipc.remove,
  restoreReferenceGroup: ipc.restore,
  purgeDeletedReferenceGroup: ipc.purge,
  removeGroupMember: ipc.removeMember,
  exportReferenceGroupPackage: ipc.exportPackage,
  importReferenceGroupPackage: ipc.importPackage,
  openReferenceGroup: () => Promise.resolve(0),
  saveReferenceGroup: () => Promise.resolve(),
  savePinsToGroup: () => Promise.resolve(),
  onReferenceGroupsChanged: (handler: () => void) => {
    ipc.changed.push(handler);
    return Promise.resolve(() => {});
  },
  onWorkspaceChanged: () => Promise.resolve(() => {}),
  workspaceDirectories: () => Promise.resolve({ status: { revision: "test", libraries: [] }, providers: [] }),
  registeredLibraries: () =>
    Promise.resolve([{ library: { id: "lib-a", name: "主库", root: "D:/a" }, unavailable: null }]),
}));

import { DeskNewGroupButton, ReferenceGroups } from "./DeskGroupsPanel";
import { SaveDestinationProvider } from "../library/SaveDestination";

const group = (id: string, name: string, extra: Partial<GroupSummary> = {}): GroupSummary => ({
  id,
  name,
  memberCount: 2,
  libraryIds: ["lib-a"],
  updatedAt: 0,
  problem: null,
  ...extra,
});
const hair = group("g1", "头发");
const hands = group("g2", "");
const old = group("g3", "旧的衣褶", { memberCount: 7 });
const bad = group("bad", "bad", { memberCount: 0, problem: { code: "groupInvalid", cause: { code: "notAGroup" } } });

const placement = { x: 0, y: 0, scale: 1, flipH: false, flipV: false, rotation: 0 };
const view = (id: string): ReferenceGroupView => ({
  group: {
    id,
    name: "头发",
    createdAt: 0,
    updatedAt: 0,
    members: [
      { id: "m1", libraryId: "lib-a", imageId: "img-1", sourceWidth: 100, sourceHeight: 80, crop: null, placement },
      { id: "m2", libraryId: "lib-a", imageId: "img-2", sourceWidth: 100, sourceHeight: 80, crop: null, placement },
    ],
  },
  members: [
    { memberId: "m1", libraryId: "lib-a", imageId: "img-1", state: { kind: "available", sealed: false } },
    { memberId: "m2", libraryId: "lib-a", imageId: "img-2", state: { kind: "available", sealed: true } },
  ],
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

async function show(lists: DeskLists) {
  ipc.lists.mockResolvedValue(lists);
  ipc.group.mockImplementation((id: string) => Promise.resolve(view(id)));
  render(
    <SaveDestinationProvider safe>
      <DeskNewGroupButton />
      <ReferenceGroups />
    </SaveDestinationProvider>,
  );
  await flush();
}

/** 参考组变了（例如切换之后）：面板重读切换列表与归档。 */
async function changed(lists: DeskLists) {
  ipc.lists.mockResolvedValue(lists);
  await act(async () => {
    for (const handler of ipc.changed) handler();
  });
  await flush();
}

const switchList = () => screen.getByRole("list", { name: "切换到" });
const archived = () => screen.getByRole("list", { name: "归档" });

async function more(name: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: `${name} 的更多操作` }));
  const entry = await screen.findByRole("menuitem", { name: item });
  await act(async () => {
    fireEvent.click(entry);
  });
  await flush();
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  ipc.changed.length = 0;
});

describe("参考组面板（参考组改成桌面）", () => {
  it("开关关着：还是原来的面板，没有“新参考组”按钮", async () => {
    ipc.lists.mockRejectedValue({ code: "deskGroupsOff" });
    render(
      <SaveDestinationProvider safe>
        <DeskNewGroupButton />
        <ReferenceGroups />
      </SaveDestinationProvider>,
    );
    await flush();
    expect(screen.getByRole("button", { name: "存下桌面钉图" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新参考组" })).toBeNull();
    expect(screen.queryByRole("list", { name: "切换到" })).toBeNull();
  });

  it("切换列表在上、归档在下；桌面上的那一项标为当前，没有名称的写“未命名”和时间", async () => {
    await show({ onDesk: "g1", switchList: [hair, hands], archived: [old] });
    const items = within(switchList()).getAllByRole("listitem");
    expect(items.map((li) => li.dataset.id)).toEqual(["g1", "g2"]);
    expect(within(items[0]).getByRole("button", { name: "头发" }).getAttribute("aria-current")).toBe("true");
    expect(
      within(items[1])
        .getByRole("button", { name: /^未命名 (?!.*更多操作)/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    const archivedItem = within(archived()).getByRole("listitem");
    expect(archivedItem.textContent).toContain("旧的衣褶");
    expect(archivedItem.textContent).toContain("7 张");
    // 归档里的单击不切换：卡片头不是按钮，只有“更多”。
    expect(
      within(archivedItem)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["旧的衣褶 的更多操作"]);
  });

  it("单击切换列表里的一项就换过去；桌面上的那一项再点不换", async () => {
    await show({ onDesk: "g1", switchList: [hair, group("g2", "手部")], archived: [] });
    fireEvent.click(screen.getByRole("button", { name: "手部" }));
    await flush();
    expect(ipc.switchTo).toHaveBeenCalledWith("g2");
    fireEvent.click(screen.getByRole("button", { name: "头发" }));
    await flush();
    expect(ipc.switchTo).toHaveBeenCalledTimes(1);
    await changed({ onDesk: "g2", switchList: [group("g2", "手部"), hair], archived: [] });
    expect(screen.getByRole("button", { name: "手部" }).getAttribute("aria-current")).toBe("true");
  });

  it("指示块第一次出现直接到位，换一项时才滑；空桌时不出现", async () => {
    await show({ onDesk: "g1", switchList: [hair, group("g2", "手部")], archived: [] });
    const mark = document.querySelector<HTMLElement>(".desk-groups-mark")!;
    expect(mark.hidden).toBe(false);
    expect(mark.style.transition).toBe("none");
    await changed({ onDesk: "g2", switchList: [hair, group("g2", "手部")], archived: [] });
    expect(mark.style.transition).toBe("");
    await changed({ onDesk: null, switchList: [hair, group("g2", "手部")], archived: [] });
    expect(mark.hidden).toBe(true);
  });

  it("“新参考组”换到空桌，列表里不多出空卡片", async () => {
    await show({ onDesk: "g1", switchList: [hair], archived: [] });
    fireEvent.click(screen.getByRole("button", { name: "新参考组" }));
    await flush();
    expect(ipc.newDesk).toHaveBeenCalled();
    await changed({ onDesk: null, switchList: [hair], archived: [] });
    expect(within(switchList()).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "头发" }).getAttribute("aria-current")).toBeNull();
  });

  it("归档后卡片到下面一段；取出后回到切换列表、成为桌面上的参考组", async () => {
    await show({ onDesk: "g1", switchList: [hair, group("g2", "手部")], archived: [] });
    await more("手部", "归档");
    expect(ipc.archive).toHaveBeenCalledWith("g2");
    await changed({ onDesk: "g1", switchList: [hair], archived: [group("g2", "手部")] });
    expect(within(archived()).getByText("手部")).toBeTruthy();
    await more("手部", "取出");
    expect(ipc.unarchive).toHaveBeenCalledWith("g2");
    await changed({ onDesk: "g2", switchList: [group("g2", "手部"), hair], archived: [] });
    expect(screen.queryByRole("list", { name: "归档" })).toBeNull();
    expect(screen.getByRole("button", { name: "手部" }).getAttribute("aria-current")).toBe("true");
  });

  it("重命名：在卡片上改，保存后收起", async () => {
    await show({ onDesk: "g1", switchList: [hair], archived: [] });
    await more("头发", "重命名");
    fireEvent.change(screen.getByLabelText("参考组名称"), { target: { value: "头发 2" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(ipc.rename).toHaveBeenCalledWith("g1", "头发 2");
    await waitFor(() => expect(screen.queryByLabelText("参考组名称")).toBeNull());
  });

  it("删除不先确认，给带“撤销”的提示；撤销把参考组放回", async () => {
    await show({ onDesk: "g1", switchList: [hair], archived: [] });
    await more("头发", "删除");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.remove).toHaveBeenCalledWith("g1");
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    });
    expect(ipc.restore).toHaveBeenCalledWith({ groupId: "g1", name: "g1", unlinkedPins: [] });
    expect(ipc.purge).not.toHaveBeenCalled();
  });

  it("导出参考组包、查看成员", async () => {
    await show({ onDesk: "g1", switchList: [hair], archived: [] });
    await more("头发", "导出参考组包");
    expect(ipc.exportPackage).toHaveBeenCalledWith("g1");
    expect(await screen.findByText("已导出参考组包：D:/导出/头发.kinshoko-group")).toBeTruthy();
    await more("头发", "查看成员");
    expect(screen.getByRole("list", { name: "头发 的成员" })).toBeTruthy();
    expect(screen.getByText("安全模式下原位遮蔽")).toBeTruthy();
  });

  it("缩略图不显示被遮蔽的图", async () => {
    await show({ onDesk: "g1", switchList: [hair], archived: [] });
    const card = within(switchList()).getByRole("listitem");
    expect([...card.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "thumb://lib-a/img-1/128",
    ]);
    expect(card.querySelectorAll(".desk-group-thumb.is-sealed")).toHaveLength(1);
  });

  it("读不懂的参考组照样列出、写明原因，只能删除", async () => {
    await show({ onDesk: "g1", switchList: [hair], archived: [bad] });
    expect(screen.getByText("参考组文件已损坏：不是 Kinshoko 参考组")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "bad 的更多操作" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["删除"]);
  });

  it("底部保留“导入参考组包”", async () => {
    await show({ onDesk: null, switchList: [], archived: [] });
    expect(screen.getByText("还没有参考组。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "导入参考组包" })).toBeTruthy();
  });
});
