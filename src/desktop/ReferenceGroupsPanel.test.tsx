import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  saveReferenceGroup: ipc.save,
  savePinsToGroup: ipc.saveInto,
  openReferenceGroup: ipc.open,
  renameReferenceGroup: ipc.rename,
  deleteReferenceGroup: ipc.remove,
  removeGroupMember: ipc.removeMember,
  exportReferenceGroupPackage: ipc.exportPackage,
  importReferenceGroupPackage: ipc.importPackage,
  onReferenceGroupsChanged: () => Promise.resolve(() => {}),
  registeredLibraries: () =>
    Promise.resolve([
      { library: { id: "lib-a", name: "主库", root: "D:/a" }, unavailable: null },
      { library: { id: "lib-b", name: "移动盘库", root: "E:/b" }, unavailable: "没插" },
    ]),
}));

import { ReferenceGroupsPanel } from "./ReferenceGroupsPanel";

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
  render(<ReferenceGroupsPanel libraryId={libraryId} />);
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("参考组面板", () => {
  it("列出参考组与引用的资料库，读不懂的文件写出原因", async () => {
    await show();
    expect(screen.getByText("头发参考")).toBeTruthy();
    expect(screen.getByText(/3 个成员/).textContent).toContain("主库、移动盘库");
    expect(screen.getByText("参考组文件已损坏")).toBeTruthy();
  });

  it("把桌面钉图存成新参考组", async () => {
    await show();
    fireEvent.change(screen.getByLabelText("新参考组名称"), { target: { value: "手部" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "把桌面钉图存为参考组" }));
    });
    expect(ipc.save).toHaveBeenCalledWith("手部");
  });

  it("保存前逐张选择截图的收藏资料库，再把选择交给保存入口", async () => {
    ipc.captures.mockResolvedValueOnce([{ id: "shot-1", width: 100, height: 80, collected: [] }]);
    await show();
    fireEvent.change(screen.getByLabelText("新参考组名称"), { target: { value: "截图参考" } });
    fireEvent.click(screen.getByRole("button", { name: "把桌面钉图存为参考组" }));
    expect(await screen.findByRole("dialog", { name: "收藏截图并保存参考组" })).toBeTruthy();
    expect(ipc.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("截图 1 的资料库"), { target: { value: "lib-a" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认并保存" })); });
    expect(ipc.save).toHaveBeenCalledWith("截图参考", [{ captureId: "shot-1", libraryId: "lib-a" }]);
  });

  it("打开参考组把成员钉到桌面", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "钉到桌面" })[0]);
    });
    expect(ipc.open).toHaveBeenCalledWith("g1");
  });

  it("查看成员时标出不可用的原因与安全模式下的遮蔽", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "成员" })[0]);
    });
    expect(ipc.group).toHaveBeenCalledWith("g1");
    expect(screen.getByText("资料库暂时不可用：没插")).toBeTruthy();
    expect(screen.getByText("安全模式下原位遮蔽")).toBeTruthy();
  });

  it("删除要再确认一次", async () => {
    await show();
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(ipc.remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    });
    expect(ipc.remove).toHaveBeenCalledWith("g1");
  });

  it("重命名", async () => {
    await show();
    fireEvent.click(screen.getAllByRole("button", { name: "重命名" })[0]);
    fireEvent.change(screen.getByLabelText("参考组名称"), { target: { value: "发型" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    });
    expect(ipc.rename).toHaveBeenCalledWith("g1", "发型");
  });

  it("导出参考组包，写出保存的位置", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "导出参考组包" })[0]);
    });
    expect(ipc.exportPackage).toHaveBeenCalledWith("g1");
    expect(screen.getByRole("status").textContent).toContain("D:/导出/头发参考.kinshoko-group");
  });

  it("取消保存对话框时不提示", async () => {
    ipc.exportPackage.mockResolvedValueOnce(null);
    await show();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "导出参考组包" })[0]);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("把参考组包导入当前资料库", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入参考组包" }));
    });
    expect(ipc.importPackage).toHaveBeenCalledWith("lib-a");
    expect(screen.getByRole("status").textContent).toContain("别人的参考组");
  });

  it("没有打开资料库时不能导入参考组包", async () => {
    await show(null);
    expect((screen.getByRole("button", { name: "导入参考组包" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
