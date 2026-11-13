import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BackupPreview } from "../bindings/BackupPreview";
import type { BackupStatus } from "../bindings/BackupStatus";
import type { RestoreReport } from "../bindings/RestoreReport";
import type { SnapshotSummary } from "../bindings/SnapshotSummary";
import { BackupReminder, BackupSettings } from "./Backup";
import { chooseOption } from "../test/select";
import { fakeBackend, type Replies } from "../test/backend";

afterEach(() => {
  delete window.__KINSHOKO_TEST_PICKS__;
});

const at = { unixMs: 1_791_158_400_000, offsetMinutes: 480 };

const empty: BackupStatus = {
  plan: { target: null, selection: { kind: "all" }, lastSuccess: null, lastSnapshot: null, lastFailure: null, due: false },
  running: null,
  lastReport: null,
};

const withTarget: BackupStatus = {
  ...empty,
  plan: { ...empty.plan, target: "E:\\备份", lastSuccess: at, lastSnapshot: "20261005-080000-abcdef" },
};

const registrations = [
  { library: { id: "A", name: "主库", root: "D:\\主库" }, unavailable: null },
  { library: { id: "B", name: "旧库", root: "D:\\旧库" }, unavailable: null },
];

const narrowed: BackupPreview = {
  scope: {
    libraries: [{ id: "A", name: "主库" }],
    groups: [{ id: "g1", name: "眼睛参考" }],
    steps: [{ kind: "linkedGroup", libraryId: "A", groupId: "g1" }],
    uncovered: [{ kind: "library", group: { id: "g1", name: "眼睛参考" }, libraryId: "B", libraryName: "旧库" }],
  },
  estimate: { totalBytes: 30 * 1024 * 1024, newBytes: 2 * 1024 * 1024, originals: 12, newOriginals: 1, unavailable: [] },
  targetAvailable: true,
};

/** 备份设置的假后端：两个已登记的图库，其余照 `replies`。 */
const backend = (replies: Replies) => fakeBackend({ registered_libraries: registrations, ...replies });

describe("设置：备份", () => {
  it("还没有备份目标时提示选择，选好的目录交给核心保存", async () => {
    const fake = backend({
      backup_status: empty,
      set_backup_target: withTarget,
      backup_preview: { ...narrowed, scope: { ...narrowed.scope, uncovered: [] } },
    });
    window.__KINSHOKO_TEST_PICKS__ = ["E:\\备份"];
    render(<BackupSettings />);

    const where = await screen.findByRole("listitem", { name: "备份位置" });
    expect(where.textContent).toMatch(/还没选/);
    expect(screen.getByRole("list", { name: "图库" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "备份" }).disabled).toBe(true);
    fireEvent.click(within(where).getByRole("button", { name: "选择…" }));
    await screen.findByText("E:\\备份");
    expect(fake.calls("set_backup_target")[0]?.args).toEqual({ target: "E:\\备份" });
    expect(screen.getByText(/10月5日 08:00$/)).toBeTruthy();
    expect(screen.getByText("已备份")).toBeTruthy();
  });

  it("按库缩小范围时列出带上的参考组、没覆盖的内容与容量", async () => {
    const fake = backend({
      backup_status: withTarget,
      set_backup_selection: (args) => ({ ...withTarget, plan: { ...withTarget.plan, selection: args.selection } }),
      backup_preview: narrowed,
    });
    render(<BackupSettings />);

    await chooseOption(await screen.findByRole("combobox", { name: "备份范围" }), "所选图库");
    const main = await screen.findByRole("checkbox", { name: "主库" });
    fireEvent.click(main);
    await waitFor(() => expect((main as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole("checkbox", { name: "带上参考组引用的图库" }));
    await waitFor(() =>
      expect(fake.calls("set_backup_selection").at(-1)?.args).toEqual({
        selection: { kind: "libraries", ids: ["A"], includeLinked: false },
      }),
    );
    expect(await screen.findByText(/参考组「眼睛参考」引用的「旧库」不在这次备份里/)).toBeTruthy();
    expect(screen.getByText(/约 30 MB，这次新写入 2 MB（新原图 1 张）/)).toBeTruthy();
  });

  it("可以马上备份；备份进行中显示进度", async () => {
    const fake = backend({ backup_status: withTarget, backup_preview: narrowed, start_backup: null });
    render(<BackupSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "备份" }));
    await waitFor(() => expect(fake.calls("start_backup").length > 0).toBe(true));
    cleanup();

    backend({ backup_status: { ...withTarget, running: { done: 3, total: 10 } }, backup_preview: narrowed });
    render(<BackupSettings />);
    expect(await screen.findByText("正在备份：原图 3 / 10")).toBeTruthy();
    expect((screen.getByRole("button", { name: "备份" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("从快照恢复后显示往返检查结果", async () => {
    const snapshot: SnapshotSummary = {
      id: "20261005-080000-abcdef",
      createdAt: at,
      libraries: [{ id: "A", name: "主库" }],
      groups: [{ id: "g1", name: "眼睛参考" }],
      skipped: [],
    };
    const report: RestoreReport = {
      snapshotId: snapshot.id,
      libraries: [{ oldId: "A", library: { id: "A2", name: "主库（恢复）", root: "F:\\恢复\\主库（恢复 2026-10-06）" } }],
      groups: [{ oldId: "g1", id: "g2", name: "眼睛参考" }],
      check: {
        originals: { checked: 12, problems: [] },
        curation: { checked: 20, problems: [] },
        groups: { checked: 1, problems: [] },
      },
    };
    const fake = backend({
      backup_status: withTarget,
      backup_preview: narrowed,
      backup_snapshots: [snapshot],
      restore_backup: report,
    });
    window.__KINSHOKO_TEST_PICKS__ = ["F:\\恢复"];
    render(<BackupSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "选择备份…" }));
    fireEvent.click(await screen.findByRole("button", { name: /^恢复 .*10月5日 08:00 的备份$/ }));
    expect(await screen.findByText("完整")).toBeTruthy();
    expect(screen.getByText(/原图 12 张已核对/)).toBeTruthy();
    expect(screen.getByText(/主库（恢复）/)).toBeTruthy();
    expect(fake.calls("restore_backup")[0]?.args).toEqual({
      snapshotId: snapshot.id,
      into: "F:\\恢复",
    });
  });
});

describe("备份提醒", () => {
  it("备份目标不在时提醒，下次再试", async () => {
    backend({
      backup_status: {
        ...withTarget,
        plan: {
          ...withTarget.plan,
          lastFailure: { at, reason: "备份位置不在：E:\\备份。请接上移动盘", targetUnavailable: true },
        },
      },
    });
    render(<BackupReminder />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/备份没有完成.*下次退出或空闲时再试/);
    expect(alert.textContent).toMatch(/请接上移动盘/);
  });

  it("在窗口里是一条出错轻提示，不再是横幅（#388）", async () => {
    backend({
      backup_status: { ...withTarget, plan: { ...withTarget.plan, lastFailure: { at, reason: "备份目标不在", targetUnavailable: true } } },
    });
    render(<><BackupReminder /></>);
    const title = (await screen.findAllByText("备份没有完成：备份目标不在")).find((node) => node.closest(".k-toast"))!;
    expect(title.closest(".k-toast")?.getAttribute("data-tone")).toBe("error");
    expect(title.closest(".k-toast")?.textContent).toContain("下次退出或空闲时再试");
    expect(document.querySelectorAll(".k-toast")).toHaveLength(1);
  });

  it("提醒重新挂载时不叠出重复的出错提示", async () => {
    backend({
      backup_status: { ...withTarget, plan: { ...withTarget.plan, lastFailure: { at, reason: "备份目标不在", targetUnavailable: true } } },
    });
    const view = render(<><BackupReminder key="a" /></>);
    await waitFor(() => expect(document.querySelectorAll(".k-toast")).toHaveLength(1));
    view.rerender(<><BackupReminder key="b" /></>);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(() => expect(document.querySelectorAll(".k-toast:not([data-ending-style])")).toHaveLength(1));
  });

  it("没有失败时不打扰", async () => {
    const fake = backend({ backup_status: withTarget });
    render(<BackupReminder />);
    await waitFor(() => expect(fake.calls("backup_status").length > 0).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
