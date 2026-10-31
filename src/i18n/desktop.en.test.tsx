import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { i18n } from "./instance";
import type { PinMenu } from "../bindings/PinMenu";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下桌面（钉图菜单、截图框选、截图历史、参考组）没有中文界面文案（#357）。
// 中文界面的文案由各组件自己的测试核对；参考组名、图库名是画师的数据。
const ipc = vi.hoisted(() => ({
  groups: vi.fn(),
  group: vi.fn(),
  captures: vi.fn(() => Promise.resolve([{ id: "shot-1", width: 100, height: 80, collected: [{ libraryId: "lib-a" }] }])),
}));
vi.mock("../ipc", () => ({
  referenceGroups: ipc.groups,
  referenceGroup: ipc.group,
  groupSaveCaptures: ipc.captures,
  captureHistory: () => Promise.resolve([
    { id: "c1", width: 412, height: 380, createdAt: Date.now() - 5 * 60_000, pinned: true, collected: [] },
    { id: "c2", width: 200, height: 100, createdAt: Date.now() - 3 * 86_400_000, pinned: false, collected: [{ libraryId: "lib-a" }] },
  ]),
  onCaptureHistory: () => Promise.resolve(() => {}),
  shellSettings: () => Promise.resolve({ shortcuts: [{ action: "capture", accelerator: "F1", problem: null }, { action: "pinClipboard", accelerator: "F3", problem: null }] }),
  captureUrl: (id: string) => `capture://${id}`,
  thumbnailUrl: (address: string) => `thumb://${address}`,
  onReferenceGroupsChanged: () => Promise.resolve(() => {}),
  onWorkspaceChanged: () => Promise.resolve(() => {}),
  workspaceDirectories: () => Promise.resolve({ status: { revision: "test", libraries: [] }, providers: [
    { registration: { library: { id: "lib-a", name: "主库", root: "D:/a" }, unavailable: null }, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} },
  ] }),
  registeredLibraries: () => Promise.resolve([
    { library: { id: "lib-a", name: "主库", root: "D:/a" }, unavailable: null },
    { library: { id: "lib-b", name: "移动盘库", root: "E:/b" }, unavailable: "unplugged" },
  ]),
}));

import { Menu } from "../ui/Menu";
import { PinMenuItems } from "../desktop/PinMenu";
import { CaptureHistoryPanel } from "../desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "../desktop/ReferenceGroupsPanel";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { ago } from "../desktop/relativeTime";

beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const data = ["主库", "移动盘库", "头发参考", "光影"];

const pin = (extra: Partial<PinMenu>): PinMenu => ({
  pin: "P1", capture: false, opacity: 70, locked: false, actualSize: false, veiled: true, canCollect: false, group: "光影",
  confirmReveal: false, ...extra,
});

function pinMenu(menu: PinMenu) {
  render(<Menu.Root open><Menu.Portal><Menu.Positioner><Menu.Popup aria-label="menu">
    <PinMenuItems menu={menu} act={vi.fn()} groups={() => Promise.resolve([])} />
  </Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>);
  return screen.getByRole("menu");
}

const summary: GroupSummary = { id: "g1", name: "头发参考", memberCount: 2, libraryIds: ["lib-a", "lib-x"], updatedAt: Date.now(), problem: null };
const placement = { x: 0, y: 0, scale: 1, flipH: false, flipV: false, rotation: 0 };
const view: ReferenceGroupView = {
  group: {
    id: "g1", name: "头发参考", createdAt: 0, updatedAt: summary.updatedAt,
    members: [
      { id: "m1", libraryId: "lib-a", imageId: "i1", sourceWidth: 100, sourceHeight: 80, crop: { x: 0, y: 0, width: 40, height: 30 }, placement },
      { id: "m2", libraryId: "lib-a", imageId: "i2", sourceWidth: 100, sourceHeight: 80, crop: null, placement },
    ],
  },
  members: [
    { memberId: "m1", libraryId: "lib-a", imageId: "i1", state: { kind: "available", sealed: false } },
    { memberId: "m2", libraryId: "lib-a", imageId: "i2", state: { kind: "available", sealed: true } },
  ],
} as ReferenceGroupView;

describe("英文界面：桌面", () => {
  it("钉图菜单：资料库钉图、截图钉图与“显示这张图？”", async () => {
    expectNoChinese(pinMenu(pin({})), data);
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to reference group" }));
    expect(await screen.findByText(/No reference groups yet/)).toBeTruthy();
    expectNoChinese(document.body, data);
    cleanup();
    expectNoChinese(pinMenu(pin({ capture: true, veiled: false, group: null, canCollect: false })));
    cleanup();
    expectNoChinese(pinMenu(pin({ confirmReveal: true })));
    expect(screen.getByRole("menuitem", { name: "Show" })).toBeTruthy();
  });

  it("截图历史与它的右键菜单", async () => {
    render(<CaptureHistoryPanel libraryId="lib-a" />);
    await settle();
    expect(screen.getByText("Press F1 to capture the screen. Old screenshots that aren't collected are cleaned up automatically.")).toBeTruthy();
    expect(screen.getByText("5 minutes ago")).toBeTruthy();
    expectNoChinese(document.body);
    fireEvent.contextMenu(screen.getAllByRole("listitem")[0]!);
    expect(await screen.findByRole("menu", { name: "Screenshot menu" })).toBeTruthy();
    expectNoChinese(document.body);
  });

  it("参考组：卡片、成员、更多操作、删除确认与截图入组", async () => {
    ipc.groups.mockResolvedValue([summary]);
    ipc.group.mockResolvedValue(view);
    render(<SaveDestinationProvider safe><ReferenceGroupsPanel /></SaveDestinationProvider>);
    await settle();
    expect(screen.getByText("2 images")).toBeTruthy();
    expect(screen.getByText("主库, Unregistered library")).toBeTruthy();
    expectNoChinese(document.body, data);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show members" }));
    await settle();
    expect(screen.getByText("Crop 40 × 30")).toBeTruthy();
    expect(screen.getByText("Hidden in place by Safe mode")).toBeTruthy();
    expectNoChinese(document.body, data);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete reference group" });
    expectNoChinese(confirm, data);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Save desktop pins" }));
    fireEvent.change(screen.getByLabelText("New reference group name"), { target: { value: "光影" } });
    expectNoChinese(document.body, data);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    const dialog = await screen.findByRole("dialog", { name: "How to save screenshots into the reference group" });
    expect(within(dialog).getByText("Collected")).toBeTruthy();
    expectNoChinese(dialog, data);
  });

  it("侧栏卡片上的相对时间", () => {
    const now = new Date(2026, 9, 10, 14, 40).getTime();
    expect(ago(now - 30_000, now)).toBe("Just now");
    expect(ago(now - 60_000, now)).toBe("1 minute ago");
    expect(ago(now - 120 * 60_000, now)).toBe("2 hours ago");
    expect(ago(new Date(2026, 9, 2).getTime(), now)).toBe("10/2");
    expect(ago(new Date(2025, 11, 30).getTime(), now)).toBe("12/30/2025");
  });
});
