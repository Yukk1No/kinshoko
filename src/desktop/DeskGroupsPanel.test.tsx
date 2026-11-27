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

const DAY = 24 * 60 * 60 * 1000;
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
const hands = group("g2", "");
const old = group("g3", "旧的衣褶", { memberCount: 7 });

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

/** 参考组变了（例如切换之后）：面板重读三段。 */
async function changed(desk: DeskLists) {
  ipc.lists.mockResolvedValue(desk);
  await act(async () => {
    for (const handler of ipc.changed) handler();
  });
  await flush();
}

const section = (name: string) => screen.getByRole("list", { name });
const ids = (name: string) =>
  within(section(name))
    .getAllByRole("listitem")
    .filter((li) => li.classList.contains("desk-group"))
    .map((li) => li.dataset.id);

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

describe("参考组面板（参考组改成桌面）", () => {
  it("收藏、最近、更早三段；更早折着，点开才列出；没有名称的写新建日期", async () => {
    await show(lists({ favorites: [hair], recent: [hands], older: [old] }));
    expect(ids("收藏")).toEqual(["g1"]);
    expect(ids("最近")).toEqual(["g2"]);
    expect(screen.getByRole("button", { name: /^头发(?! 的更多操作)/ }).getAttribute("aria-current")).toBe("page");
    expect(
      within(section("最近"))
        .getByRole("button", { name: /^11月18日(?!.*更多操作)/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    const toggle = screen.getByRole("button", { name: /^更早\s*1$/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("旧的衣褶")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(section("更早")).getByText("旧的衣褶")).toBeTruthy();
    expect(within(section("更早")).getByText("7")).toBeTruthy();
  });

  it("单击一项就换过去；桌面上的那一项再点不换", async () => {
    await show(lists({ recent: [hair, group("g2", "手部")] }));
    fireEvent.click(screen.getByRole("button", { name: "手部" }));
    await flush();
    expect(ipc.switchTo).toHaveBeenCalledWith("g2");
    fireEvent.click(screen.getByRole("button", { name: /^头发(?! 的更多操作)/ }));
    await flush();
    expect(ipc.switchTo).toHaveBeenCalledTimes(1);
    await changed(lists({ onDesk: "g2", recent: [hair, group("g2", "手部")] }));
    expect(screen.getByRole("button", { name: /^手部(?! 的更多操作)/ }).getAttribute("aria-current")).toBe("page");
  });

  it("收藏、最近也能折起；折起时段标题还在，张数写在标题上", async () => {
    await show(lists({ favorites: [hair], recent: [group("g2", "手部")] }));
    const toggle = screen.getByRole("button", { name: /^最近\s*1$/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "最近" })).toBeNull();
    expect(ids("收藏")).toEqual(["g1"]);
  });

  it("“新参考组”清空桌面；桌面空着时变灰、没有高亮的一项", async () => {
    await show(lists({ recent: [hair] }));
    fireEvent.click(screen.getByRole("button", { name: "新参考组" }));
    await flush();
    expect(ipc.newDesk).toHaveBeenCalled();
    await changed(lists({ onDesk: null, recent: [hair] }));
    expect((screen.getByRole("button", { name: "新参考组" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "头发" }).getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("group", { name: "头发 的成员" })).toBeNull();
  });

  it("没收藏的组：已关闭的折进“已关闭 N 张”，展开后点一下钉住", async () => {
    members = [member("m1", { pinned: false }), member("m2")];
    await show(lists({ recent: [hair] }));
    const shown = screen.getByRole("group", { name: "头发 的成员" });
    expect(within(shown).getAllByRole("listitem")).toHaveLength(1);
    const fold = within(shown).getByRole("button", { name: "已关闭 1 张" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    fireEvent.click(within(shown).getByRole("button", { name: "钉住主库" }));
    await flush();
    expect(ipc.repin).toHaveBeenCalledWith("g1", "m1");
  });

  it("参考组变化时重读桌面上那组的成员，钉回后“已关闭”立即消失（#778）", async () => {
    members = [member("m1"), member("m2", { pinned: false })];
    await show(lists({ recent: [hair] }));
    expect(
      within(screen.getByRole("group", { name: "头发 的成员" })).getByRole("button", { name: "已关闭 1 张" }),
    ).toBeTruthy();
    const reads = ipc.group.mock.calls.length;

    members = [member("m1"), member("m2")];
    await changed(lists({ recent: [hair] }));

    expect(ipc.group.mock.calls.length).toBe(reads + 1);
    expect(
      within(screen.getByRole("group", { name: "头发 的成员" })).queryByRole("button", { name: /已关闭/ }),
    ).toBeNull();
  });

  it("收藏的组：成员留在原位，已关闭的变淡", async () => {
    members = [member("m1", { pinned: false }), member("m2")];
    await show(lists({ favorites: [hair] }));
    const shown = screen.getByRole("group", { name: "头发 的成员" });
    const tiles = within(shown).getAllByRole("listitem");
    expect(tiles.map((li) => li.classList.contains("is-unpinned"))).toEqual([true, false]);
    expect(within(shown).queryByRole("button", { name: /已关闭/ })).toBeNull();
  });

  it("移出一个成员不先确认，提示里能撤销", async () => {
    await show(lists({ recent: [hair] }));
    fireEvent.click(screen.getAllByRole("button", { name: "移出主库" })[0]);
    await flush();
    expect(ipc.removeMember).toHaveBeenCalledWith("g1", "m1");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    });
    expect(ipc.undoPrune).toHaveBeenCalled();
  });

  it("移出时那组已经不在桌面上：照样移出，不给撤销不了的“撤销”", async () => {
    ipc.removeMember.mockResolvedValueOnce(false);
    await show(lists({ recent: [hair] }));
    fireEvent.click(screen.getAllByRole("button", { name: "移出主库" })[0]);
    await flush();
    expect(ipc.removeMember).toHaveBeenCalledWith("g1", "m1");
    expect(screen.queryByRole("button", { name: "撤销", hidden: true })).toBeNull();
  });

  it("接连移出两张：只留最近那次的“撤销”，撤销写不进时错误提示上能再撤销", async () => {
    members = [member("m1"), member("m2")];
    await show(lists({ recent: [hair] }));
    fireEvent.click(screen.getAllByRole("button", { name: "移出主库" })[0]);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "移出主库" })[1]);
    await flush();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "撤销" })).toHaveLength(1));
    ipc.undoPrune.mockRejectedValueOnce({ code: "io", message: "写不进" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    });
    await flush();
    // 错误提示在原来那条退场时还被挡在无障碍树外，按按钮本身找。
    const retry = (await screen.findAllByRole("button", { name: "撤销", hidden: true })).find(
      (b) => b.getAttribute("data-type") === "error",
    );
    await act(async () => {
      fireEvent.click(retry!);
    });
    expect(ipc.undoPrune).toHaveBeenCalledTimes(2);
  });

  it("成员跨几天时按添加日期分段，早的在前", async () => {
    members = [member("m1", { addedAt: NOV_18 + DAY }), member("m2", { addedAt: NOV_18 })];
    await show(lists({ recent: [hair] }));
    const days = within(screen.getByRole("group", { name: "头发 的成员" })).getAllByRole("heading");
    expect(days.map((h) => h.textContent)).toEqual([
      expect.stringMatching(/11月18日/),
      expect.stringMatching(/11月19日/),
    ]);
  });
});

describe("参考组面板：移到新参考组", () => {
  it("较新的一段可以移到新参考组，提示里能撤销；最早那天没有这一项", async () => {
    members = [member("m1", { addedAt: NOV_18 }), member("m2", { addedAt: NOV_18 + DAY })];
    await show(lists({ recent: [hair] }));
    const shown = screen.getByRole("group", { name: "头发 的成员" });
    const buttons = within(shown).getAllByRole("button", { name: "移到新参考组" });
    expect(buttons).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: /11月19日/ })).getByRole("button", { name: "移到新参考组" })).toBe(
      buttons[0],
    );
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    await flush();
    const d = new Date(NOV_18 + DAY);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(ipc.split).toHaveBeenCalledWith(day);
    expect(await screen.findByText("已移到新参考组")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    });
    expect(ipc.undoSplit).toHaveBeenCalled();
    expect(ipc.undoPrune).not.toHaveBeenCalled();
  });

  it("接连移到新参考组两次：只留最近那次的“撤销”，撤销写不进时错误提示上能再撤销", async () => {
    members = [member("m1", { addedAt: NOV_18 }), member("m2", { addedAt: NOV_18 + DAY })];
    await show(lists({ recent: [hair] }));
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "移到新参考组" }));
      });
      await flush();
    }
    await waitFor(() => expect(screen.getAllByRole("button", { name: "撤销" })).toHaveLength(1));
    ipc.undoSplit.mockRejectedValueOnce({ code: "io", message: "写不进" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    });
    await flush();
    const retry = (await screen.findAllByRole("button", { name: "撤销", hidden: true })).find(
      (b) => b.getAttribute("data-type") === "error",
    );
    await act(async () => {
      fireEvent.click(retry!);
    });
    expect(ipc.undoSplit).toHaveBeenCalledTimes(2);
  });

  it("移到新参考组后没能摆上桌面：错误提示说成员已移过去，上面照样能撤销", async () => {
    members = [member("m1", { addedAt: NOV_18 }), member("m2", { addedAt: NOV_18 + DAY })];
    ipc.split.mockResolvedValueOnce({ to: "g9", switchError: { code: "io", message: "换不过去" } });
    await show(lists({ recent: [hair] }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "移到新参考组" }));
    });
    await flush();
    expect(await screen.findByText("已移到新参考组，但没能摆上桌面")).toBeTruthy();
    expect(screen.queryByText("已移到新参考组")).toBeNull();
    const undo = (await screen.findAllByRole("button", { name: "撤销", hidden: true })).find(
      (b) => b.getAttribute("data-type") === "error",
    );
    await act(async () => {
      fireEvent.click(undo!);
    });
    expect(ipc.undoSplit).toHaveBeenCalled();
  });

  it("最早那天的都已关闭、折起来时，较新的一段照样能移到新参考组", async () => {
    members = [member("m1", { addedAt: NOV_18, pinned: false }), member("m2", { addedAt: NOV_18 + DAY })];
    await show(lists({ recent: [hair] }));
    const shown = screen.getByRole("group", { name: "头发 的成员" });
    expect(within(shown).getAllByRole("button", { name: "移到新参考组" })).toHaveLength(1);
  });
});
