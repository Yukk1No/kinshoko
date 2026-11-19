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
  rename: vi.fn(() => Promise.resolve()),
  remove: vi.fn((id: string) => Promise.resolve({ groupId: id, name: id, unlinkedPins: [] })),
  restore: vi.fn(() => Promise.resolve()),
  purge: vi.fn(() => Promise.resolve()),
  removeMember: vi.fn(() => Promise.resolve(null)),
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
  repinGroupMember: ipc.repin,
  pruneUnpinnedMembers: ipc.prune,
  undoPruneUnpinned: ipc.undoPrune,
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

async function more(name: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: `${name} 的更多操作` }));
  const entry = await screen.findByRole("menuitem", { name: item });
  await act(async () => {
    fireEvent.click(entry);
  });
  await flush();
}

// jsdom 没有 ResizeObserver；指示块只用它跟随尺寸变化。
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
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
    expect(screen.queryByRole("list", { name: "常用" })).toBeNull();
  });

  it("常用、最近、更早三段；更早折着，点开才列出；没有名称的写新建日期", async () => {
    await show(lists({ favorites: [hair], recent: [hands], older: [old] }));
    expect(ids("常用")).toEqual(["g1"]);
    expect(ids("最近")).toEqual(["g2"]);
    expect(screen.getByRole("button", { name: /^头发(?! 的更多操作)/ }).getAttribute("aria-current")).toBe("true");
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
    expect(within(section("更早")).getByText("7 张")).toBeTruthy();
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
    expect(screen.getByRole("button", { name: /^手部(?! 的更多操作)/ }).getAttribute("aria-current")).toBe("true");
  });

  it("指示块第一次出现直接到位，换一项时才滑；桌面空着时不出现", async () => {
    await show(lists({ favorites: [hair], recent: [group("g2", "手部")] }));
    const mark = document.querySelector<HTMLElement>(".desk-groups-mark")!;
    expect(mark.hidden).toBe(false);
    expect(mark.style.transition).toBe("none");
    await changed(lists({ onDesk: "g2", favorites: [hair], recent: [group("g2", "手部")] }));
    expect(mark.style.transition).toBe("");
    await changed(lists({ onDesk: null, favorites: [hair], recent: [group("g2", "手部")] }));
    expect(mark.hidden).toBe(true);
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

  it("桌面上那组展开成员：钉着的在前，没钉着的点一下钉回", async () => {
    members = [member("m1", { pinned: false }), member("m2")];
    await show(lists({ recent: [hair] }));
    const shown = screen.getByRole("group", { name: "头发 的成员" });
    const tiles = within(shown).getAllByRole("listitem");
    expect(tiles.map((li) => li.classList.contains("is-unpinned"))).toEqual([false, true]);
    fireEvent.click(within(shown).getByRole("button", { name: "钉回主库" }));
    await flush();
    expect(ipc.repin).toHaveBeenCalledWith("m1");
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

describe("参考组面板的“更多”", () => {
  it("桌面上那组：改名、设为常用、复制、移出没钉着的、导出、删除", async () => {
    await show(lists({ recent: [hair] }));
    fireEvent.click(screen.getByRole("button", { name: "头发 的更多操作" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "重命名",
      "设为常用",
      "复制",
      "移出没钉着的",
      "导出参考组包",
      "删除",
    ]);
  });

  it("设为常用、取消常用", async () => {
    await show(lists({ favorites: [group("g2", "手部")], recent: [hair] }));
    await more("头发", "设为常用");
    expect(ipc.favorite).toHaveBeenCalledWith("g1", true);
    await more("手部", "取消常用");
    expect(ipc.favorite).toHaveBeenCalledWith("g2", false);
  });

  it("复制：新参考组叫“某某 副本”", async () => {
    await show(lists({ recent: [hair] }));
    await more("头发", "复制");
    expect(ipc.duplicate).toHaveBeenCalledWith("g1", "头发 副本");
  });

  it("移出没钉着的：提示移出了几张，能撤销", async () => {
    await show(lists({ recent: [hair] }));
    await more("头发", "移出没钉着的");
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

  it("不在桌面上的卡片有缩略图，不显示被遮蔽的图", async () => {
    await show(lists({ recent: [hair, group("g2", "手部")] }));
    const card = within(section("最近"))
      .getAllByRole("listitem")
      .find((li) => li.dataset.id === "g2")!;
    expect([...card.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "thumb://lib-a/img-m1/128",
    ]);
    expect(card.querySelectorAll(".desk-group-thumb.is-sealed")).toHaveLength(1);
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
});
