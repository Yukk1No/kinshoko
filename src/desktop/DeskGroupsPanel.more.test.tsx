import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeskLists } from "../bindings/DeskLists";
import type { GroupMember } from "../bindings/GroupMember";
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
  favorite: vi.fn(() => Promise.resolve()),
  duplicate: vi.fn(() => Promise.resolve("copy")),
  repin: vi.fn(() => Promise.resolve()),
  prune: vi.fn(() => Promise.resolve(1)),
  undoPrune: vi.fn(() => Promise.resolve()),
  split: vi.fn(
    (): Promise<{ to: string; switchError: unknown } | null> => Promise.resolve({ to: "g9", switchError: null }),
  ),
  undoSplit: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  remove: vi.fn((id: string) => Promise.resolve({ groupId: id, name: id, unlinkedPins: [] })),
  restore: vi.fn(() => Promise.resolve()),
  purge: vi.fn(() => Promise.resolve()),
  removeMember: vi.fn((): Promise<boolean> => Promise.resolve(true)),
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
  setReferenceGroupFavorite: ipc.favorite,
  duplicateReferenceGroup: ipc.duplicate,
  showGroupMember: ipc.repin,
  pruneUnpinnedMembers: ipc.prune,
  undoPruneUnpinned: ipc.undoPrune,
  splitOffReferenceGroup: ipc.split,
  undoSplitOff: ipc.undoSplit,
  renameReferenceGroup: ipc.rename,
  deleteReferenceGroup: ipc.remove,
  restoreReferenceGroup: ipc.restore,
  purgeDeletedReferenceGroup: ipc.purge,
  removeDeskGroupMember: ipc.removeMember,
  exportReferenceGroupPackage: ipc.exportPackage,
  importReferenceGroupPackage: ipc.importPackage,
  openReferenceGroup: () => Promise.resolve(0),
  saveReferenceGroup: () => Promise.resolve(),
  savePinsToGroup: () => Promise.resolve(),
  onReferenceGroupsChanged: (handler: () => void) => {
    ipc.changed.push(handler);
    return Promise.resolve(() => {
      const at = ipc.changed.indexOf(handler);
      if (at >= 0) ipc.changed.splice(at, 1);
    });
  },
  onWorkspaceChanged: () => Promise.resolve(() => {}),
  workspaceDirectories: () => Promise.resolve({ status: { revision: "test", libraries: [] }, providers: [] }),
  registeredLibraries: () =>
    Promise.resolve([{ library: { id: "lib-a", name: "主库", root: "D:/a" }, unavailable: null }]),
}));

import { DeskNewGroupButton, ReferenceGroups } from "./DeskGroupsPanel";
import { SaveDestinationProvider } from "../library/SaveDestination";

const NOV_18 = new Date(2026, 10, 18, 10).getTime();

const group = (id: string, name: string, extra: Partial<GroupSummary> = {}): GroupSummary => ({
  id,
  name,
  memberCount: 2,
  libraryIds: ["lib-a"],
  createdAt: NOV_18,
  updatedAt: 0,
  problem: null,
  ...extra,
});
const hair = group("g1", "头发");
const bad = group("bad", "bad", { memberCount: 0, problem: { code: "groupInvalid", cause: { code: "notAGroup" } } });

const placement = { x: 0, y: 0, scale: 1, flipH: false, flipV: false, rotation: 0 };
const member = (id: string, extra: Partial<GroupMember> = {}): GroupMember => ({
  id,
  libraryId: "lib-a",
  imageId: `img-${id}`,
  sourceWidth: 100,
  sourceHeight: 80,
  crop: null,
  placement,
  ...extra,
});
let members: GroupMember[] = [member("m1"), member("m2", { pinned: false })];
const view = (id: string): ReferenceGroupView => ({
  group: { id, name: "头发", createdAt: NOV_18, updatedAt: 0, members },
  members: members.map((m, i) => ({
    memberId: m.id,
    libraryId: "lib-a",
    imageId: `img-${m.id}`,
    state: { kind: "available", sealed: i === 1 && id !== "g1" },
  })),
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

const lists = (extra: Partial<DeskLists>): DeskLists => ({
  onDesk: "g1",
  favorites: [],
  recent: [],
  older: [],
  ...extra,
});

async function show(desk: DeskLists) {
  ipc.lists.mockResolvedValue(desk);
  ipc.group.mockImplementation((id: string) => Promise.resolve(view(id)));
  render(
    <SaveDestinationProvider safe>
      <DeskNewGroupButton />
      <ReferenceGroups />
    </SaveDestinationProvider>,
  );
  await flush();
}

const section = (name: string) => screen.getByRole("list", { name });
async function more(name: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: `${name} 的更多操作` }));
  const entry = await screen.findByRole("menuitem", { name: item });
  await act(async () => {
    fireEvent.click(entry);
  });
  await flush();
}

// jsdom 没有 ResizeObserver；悬停高亮块（FluidList）用它跟随行的尺寸。
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  ipc.changed.length = 0;
  members = [member("m1"), member("m2", { pinned: false })];
});

describe("参考组面板的“更多”", () => {
  it("桌面上那组：改名、收藏、复制、移出已关闭、导出、删除", async () => {
    await show(lists({ recent: [hair] }));
    fireEvent.click(screen.getByRole("button", { name: "头发 的更多操作" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["重命名", "收藏", "复制", "移出已关闭", "导出参考组包", "删除"]);
  });

  it("卡片右键与“⋯”是同一组菜单项", async () => {
    await show(lists({ recent: [hair] }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /^头发(?! 的更多操作)/ }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["重命名", "收藏", "复制", "移出已关闭", "导出参考组包", "删除"]);
  });

  it("收藏、取消收藏", async () => {
    await show(lists({ favorites: [group("g2", "手部")], recent: [hair] }));
    await more("头发", "收藏");
    expect(ipc.favorite).toHaveBeenCalledWith("g1", true);
    await more("手部", "取消收藏");
    expect(ipc.favorite).toHaveBeenCalledWith("g2", false);
  });

  it("复制：新参考组叫“某某 副本”", async () => {
    await show(lists({ recent: [hair] }));
    await more("头发", "复制");
    expect(ipc.duplicate).toHaveBeenCalledWith("g1", "头发 副本");
  });

  it("移出已关闭：提示移出了几张，能撤销", async () => {
    await show(lists({ recent: [hair] }));
    await more("头发", "移出已关闭");
    expect(ipc.prune).toHaveBeenCalled();
    expect(await screen.findByText("已移出 1 张")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    });
    expect(ipc.undoPrune).toHaveBeenCalled();
  });

  it("重命名：在卡片上改，保存后收起", async () => {
    await show(lists({ recent: [hair] }));
    await more("头发", "重命名");
    fireEvent.change(screen.getByLabelText("参考组名称"), { target: { value: "头发 2" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(ipc.rename).toHaveBeenCalledWith("g1", "头发 2");
    await waitFor(() => expect(screen.queryByLabelText("参考组名称")).toBeNull());
    // 留空也能保存：回到写新建时间（#588）。
    await more("头发", "重命名");
    fireEvent.change(screen.getByLabelText("参考组名称"), { target: { value: "" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(ipc.rename).toHaveBeenLastCalledWith("g1", "");
  });

  it("删除不先确认，给带“撤销”的提示；撤销把参考组放回", async () => {
    await show(lists({ recent: [hair] }));
    await more("头发", "删除");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.remove).toHaveBeenCalledWith("g1");
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    });
    expect(ipc.restore).toHaveBeenCalledWith({ groupId: "g1", name: "g1", unlinkedPins: [] });
    expect(ipc.purge).not.toHaveBeenCalled();
  });

  it("导出参考组包", async () => {
    await show(lists({ recent: [hair] }));
    await more("头发", "导出参考组包");
    expect(ipc.exportPackage).toHaveBeenCalledWith("g1");
    expect(await screen.findByText("已导出参考组包：D:/导出/头发.kinshoko-group")).toBeTruthy();
  });

  it("不在桌面上的参考组只有一行：名字和张数，不读成员", async () => {
    await show(lists({ recent: [hair, group("g2", "手部")] }));
    const row = within(section("最近"))
      .getAllByRole("listitem")
      .find((li) => li.dataset.id === "g2")!;
    expect(row.querySelector(".sidebar-count")?.textContent).toBe("2");
    expect(row.querySelectorAll("img")).toHaveLength(0);
    expect(ipc.group).not.toHaveBeenCalledWith("g2");
  });

  it("读不懂的参考组照样列出、写明原因，只能删除", async () => {
    await show(lists({ recent: [hair, bad] }));
    expect(screen.getByText("参考组文件已损坏：不是 Kinshoko 参考组")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "bad 的更多操作" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["删除"]);
  });

  it("底部保留“导入参考组包”", async () => {
    await show(lists({ onDesk: null }));
    expect(screen.getByText("还没有参考组。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "导入参考组包" })).toBeTruthy();
  });

  it("ReferenceGroups 与 DeskNewGroupButton 同屏渲染时共享订阅，只发一次读取与监听（#716）", async () => {
    await show(lists({ recent: [hair] }));
    expect(screen.getByText("头发")).toBeTruthy();
    expect(ipc.lists).toHaveBeenCalledTimes(1);
    expect(ipc.changed).toHaveLength(1);
  });

  it("全部卸载后重置快照并退订，再挂载时重新订阅（#716）", async () => {
    await show(lists({ recent: [hair] }));
    expect(screen.getByText("头发")).toBeTruthy();
    expect(ipc.changed).toHaveLength(1);
    cleanup();
    expect(ipc.changed).toHaveLength(0);

    let resolveLists: (value: DeskLists) => void = () => {};
    ipc.lists.mockImplementation(
      () =>
        new Promise<DeskLists>((resolve) => {
          resolveLists = resolve;
        }),
    );
    render(
      <SaveDestinationProvider safe>
        <DeskNewGroupButton />
        <ReferenceGroups />
      </SaveDestinationProvider>,
    );
    await flush();
    expect(document.querySelector(".reference-groups")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("头发")).toBeNull();
    expect(ipc.lists).toHaveBeenCalledTimes(2);
    expect(ipc.changed).toHaveLength(1);

    await act(async () => {
      resolveLists(lists({ recent: [hair] }));
    });
    await flush();
    expect(screen.getByText("头发")).toBeTruthy();
  });
});
