import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";

// 主窗口的参考组面板（#66）。IPC 用替身；钉到桌面的效果见发布检查清单。
const ipc = vi.hoisted(() => ({
  groups: vi.fn(),
  group: vi.fn(),
  captures: vi.fn(() => Promise.resolve<Array<{ id: string; width: number; height: number; collected: unknown[] }>>([])),
  save: vi.fn(() => Promise.resolve()),
  saveInto: vi.fn(() => Promise.resolve()),
  open: vi.fn(() => Promise.resolve(2)),
  rename: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  removeMember: vi.fn(() => Promise.resolve()),
  exportPackage: vi.fn((): Promise<string | null> => Promise.resolve("D:/导出/头发参考.kinshoko-group")),
  importPackage: vi.fn(() => Promise.resolve({ name: "别人的参考组" } as unknown)),
}));

vi.mock("../ipc", () => ({
  referenceGroups: ipc.groups,
  referenceGroup: ipc.group,
  groupSaveCaptures: ipc.captures,
  captureUrl: (id: string) => `capture://${id}`,
  thumbnailUrl: (address: string) => `thumb://${address}`,
  saveReferenceGroup: ipc.save,
  savePinsToGroup: ipc.saveInto,
  openReferenceGroup: ipc.open,
  renameReferenceGroup: ipc.rename,
  deleteReferenceGroup: ipc.remove,
  removeGroupMember: ipc.removeMember,
  exportReferenceGroupPackage: ipc.exportPackage,
  importReferenceGroupPackage: ipc.importPackage,
  onReferenceGroupsChanged: () => Promise.resolve(() => {}),
  onWorkspaceChanged: () => Promise.resolve(() => {}),
  workspaceDirectories: () => Promise.resolve({ status:{revision:"test",libraries:[]}, providers:[{registration:{library:{id:"lib-a",name:"主库",root:"D:/a"},unavailable:null},sidebar:{all:0,trash:0,folders:[{id:"folder-a",name:"截图目录",children:[],count:0}]},unassigned:0,descendants:{}}] }),
  registeredLibraries: () =>
    Promise.resolve([
      { library: { id: "lib-a", name: "主库", root: "D:/a" }, unavailable: null },
      { library: { id: "lib-b", name: "移动盘库", root: "E:/b" }, unavailable: "没插" },
    ]),
}));

import { ReferenceGroupsPanel } from "./ReferenceGroupsPanel";
import { SaveDestinationProvider } from "../library/SaveDestination";

const summary: GroupSummary = {
  id: "g1",
  name: "头发参考",
  memberCount: 3,
  libraryIds: ["lib-a", "lib-b"],
  updatedAt: 0,
  problem: null,
};

const placement = { x: 0, y: 0, scale: 1, flipH: false, flipV: false, rotation: 0 };
const member = (id: string, libraryId: string) => ({
  id,
  libraryId,
  imageId: `img-${id}`,
  sourceWidth: 100,
  sourceHeight: 80,
  crop: null,
  placement,
});
const view: ReferenceGroupView = {
  group: {
    id: "g1",
    name: "头发参考",
    createdAt: 0,
    updatedAt: 0,
    members: [member("m1", "lib-a"), member("m2", "lib-a"), member("m3", "lib-b")],
  },
  members: [
    { memberId: "m1", libraryId: "lib-a", imageId: "img-m1", state: { kind: "available", sealed: false } },
    { memberId: "m2", libraryId: "lib-a", imageId: "img-m2", state: { kind: "available", sealed: true } },
    {
      memberId: "m3",
      libraryId: "lib-b",
      imageId: "img-m3",
      state: {
        kind: "unavailable",
        reason: { kind: "libraryUnavailable", detail: "没插" },
        message: "资料库暂时不可用：没插",
      },
    },
  ],
};

async function show(libraryId: string | null = "lib-a") {
  ipc.groups.mockResolvedValue([
    summary,
    { ...summary, id: "bad", name: "bad", memberCount: 0, libraryIds: [], problem: "参考组文件已损坏" },
  ]);
  ipc.group.mockResolvedValue(view);
  render(<SaveDestinationProvider safe><ReferenceGroupsPanel libraryId={libraryId} /></SaveDestinationProvider>);
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The selected card's “更多” menu. */
async function more(item: string) {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  const entry = await screen.findByRole("menuitem", { name: item });
  await act(async () => { fireEvent.click(entry); });
}

describe("参考组面板", () => {
  it("列出参考组与引用的资料库，读不懂的文件写出原因", async () => {
    await show();
    expect(screen.getByText("头发参考")).toBeTruthy();
    expect(screen.getByText(/^3 张/).textContent).toMatch(/^3 张 · 主库、移动盘库 · \d{4} 年 \d+ 月 \d+ 日$/);
    expect(screen.getByText("参考组文件已损坏")).toBeTruthy();
  });

  it("卡片缩略图只显示可用成员；安全模式遮蔽和不可用的成员不加载图片", async () => {
    await show();
    const card = screen.getByText("头发参考").closest("li")!;
    const thumbs = card.querySelectorAll("img");
    expect([...thumbs].map((img) => img.getAttribute("src"))).toEqual(["thumb://lib-a/img-m1/128"]);
    expect(card.querySelectorAll(".group-thumb")).toHaveLength(3);
  });

  it("把桌面钉图存成新参考组：先起名，空名不能保存", async () => {
    await show();
    expect(screen.queryByLabelText("新参考组名称")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "存下桌面钉图" }));
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("新参考组名称"), { target: { value: "手部" } });
    await act(async () => { fireEvent.click(save); });
    expect(ipc.save).toHaveBeenCalledWith("手部");
    expect(screen.getByRole("status").textContent).toBe("已把桌面钉图存为参考组");
  });

  it("保存前逐张选择截图的收藏资料库，再把选择交给保存入口", async () => {
    ipc.captures.mockResolvedValueOnce([{ id: "shot-1", width: 100, height: 80, collected: [] }]);
    await show();
    fireEvent.click(screen.getByRole("button", { name: "存下桌面钉图" }));
    fireEvent.change(screen.getByLabelText("新参考组名称"), { target: { value: "截图参考" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const dialog = await screen.findByRole("dialog", { name: "收藏截图并保存参考组" });
    // 界面系统的模态对话框：焦点进入对话框并留在里面。
    expect(dialog.className).toContain("k-dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(ipc.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("截图 1 的图库"), { target: { value: "lib-a" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认并保存" })); });
    expect(ipc.save).toHaveBeenCalledWith("截图参考", [{ captureId: "shot-1", libraryId: "lib-a", folderId:null }]);
  });

  it("打开参考组把成员钉到桌面", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "摆到桌面" }));
    });
    expect(ipc.open).toHaveBeenCalledWith("g1");
    expect(screen.getByRole("status").textContent).toBe("已钉出 2 个成员");
  });

  it("操作只出现在选中的卡片上；点另一张卡片换过去", async () => {
    ipc.groups.mockResolvedValue([summary, { ...summary, id: "g2", name: "手部" }]);
    ipc.group.mockResolvedValue(view);
    render(<SaveDestinationProvider safe><ReferenceGroupsPanel /></SaveDestinationProvider>);
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(screen.getAllByRole("button", { name: "摆到桌面" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^手部/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "摆到桌面" })); });
    expect(ipc.open).toHaveBeenCalledWith("g2");
  });

  it("查看成员时标出不可用的原因与安全模式下的遮蔽", async () => {
    await show();
    expect(screen.queryByText("资料库暂时不可用：没插")).toBeNull();
    await more("查看成员");
    expect(ipc.group).toHaveBeenCalledWith("g1");
    expect(screen.getByText("资料库暂时不可用：没插")).toBeTruthy();
    expect(screen.getByText("安全模式下原位遮蔽")).toBeTruthy();
  });

  it("删除要再确认一次", async () => {
    await show();
    await more("删除");
    expect(ipc.remove).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog", { name: "删除参考组" });
    expect(confirm.textContent).toContain("头发参考");
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    });
    expect(ipc.remove).toHaveBeenCalledWith("g1");
  });

  it("重命名", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "改名" }));
    fireEvent.change(screen.getByLabelText("参考组名称"), { target: { value: "发型" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    });
    expect(ipc.rename).toHaveBeenCalledWith("g1", "发型");
  });

  it("导出参考组包，写出保存的位置", async () => {
    await show();
    await more("导出参考组包");
    expect(ipc.exportPackage).toHaveBeenCalledWith("g1");
    expect(screen.getByRole("status").textContent).toContain("D:/导出/头发参考.kinshoko-group");
  });

  it("取消保存对话框时不提示", async () => {
    ipc.exportPackage.mockResolvedValueOnce(null);
    await show();
    await more("导出参考组包");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("把参考组包导入明确选择的资料库和目录", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入参考组包" }));
    });
    expect(ipc.importPackage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox",{name:"图库"}),{target:{value:"lib-a"}});
    fireEvent.change(screen.getByRole("combobox",{name:"文件夹"}),{target:{value:"folder-a"}});
    await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"选择参考组包并导入"}));});
    expect(ipc.importPackage).toHaveBeenCalledWith("lib-a",{libraryId:"lib-a",folderId:"folder-a"});
    expect(screen.getByRole("status").textContent).toContain("别人的参考组");
  });

  it("存入桌面钉图到已有参考组", async () => {
    await show();
    await more("存入桌面钉图");
    expect(ipc.saveInto).toHaveBeenCalledWith("g1");
  });

  it("读不懂的参考组只能删除", async () => {
    await show();
    const bad = screen.getByText("参考组文件已损坏").closest("li")!;
    fireEvent.click(within(bad).getByRole("button", { name: /^bad/ }));
    expect(within(bad).queryByRole("button", { name: "摆到桌面" })).toBeNull();
    fireEvent.click(within(bad).getByRole("button", { name: "删除" }));
    const confirm = await screen.findByRole("alertdialog", { name: "删除参考组" });
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "删除" })); });
    expect(ipc.remove).toHaveBeenCalledWith("bad");
  });

  it("没有活动库时仍可从明确目标导入参考组包", async () => {
    await show(null);
    expect((screen.getByRole("button", { name: "导入参考组包" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
