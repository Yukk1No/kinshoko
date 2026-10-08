import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { BackupPreview } from "./bindings/BackupPreview";
import type { BackupStatus } from "./bindings/BackupStatus";
import type { RestoreReport } from "./bindings/RestoreReport";
import type { SnapshotSummary } from "./bindings/SnapshotSummary";
import { BackupReminder, BackupSettings } from "./Backup";

afterEach(() => {
  cleanup();
  clearMocks();
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

function backend(handle: (cmd: string, args: Record<string, unknown>) => unknown) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "plugin:library|registered_libraries") return registrations;
    if (cmd === "plugin:event|listen") return 1;
    return handle(cmd, a);
  });
  return calls;
}

describe("设置：备份", () => {
  it("还没有备份目标时提示选择，选好的目录交给核心保存", async () => {
    const calls = backend((cmd) => {
      if (cmd === "backup_status") return empty;
      if (cmd === "set_backup_target") return withTarget;
      if (cmd === "backup_preview") return { ...narrowed, scope: { ...narrowed.scope, uncovered: [] } };
      return undefined;
    });
    window.__KINSHOKO_TEST_PICKS__ = ["E:\\备份"];
    render(<BackupSettings />);

    expect(await screen.findByText(/还没有选择备份目录/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "资料库备份" })).toBeTruthy();
    expect(screen.getByText(/恢复资料库保留当前程序设置/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择备份目录…" }));
    await screen.findByText("E:\\备份");
    expect(calls.find((c) => c.cmd === "set_backup_target")?.args).toEqual({ target: "E:\\备份" });
    expect(screen.getByText(/上次备份：2026-10-05 08:00/)).toBeTruthy();
  });

  it("按库缩小范围时列出带上的参考组、没覆盖的内容与容量", async () => {
    const calls = backend((cmd, args) => {
      if (cmd === "backup_status") return withTarget;
      if (cmd === "set_backup_selection") return { ...withTarget, plan: { ...withTarget.plan, selection: args.selection } };
      if (cmd === "backup_preview") return narrowed;
      return undefined;
    });
    render(<BackupSettings />);

    fireEvent.click(await screen.findByRole("radio", { name: "只备份所选资料库" }));
    const main = await screen.findByRole("checkbox", { name: "主库" });
    fireEvent.click(main);
    await waitFor(() => expect((main as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole("checkbox", { name: "一起备份参考组还引用的资料库" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "set_backup_selection").at(-1)?.args).toEqual({
        selection: { kind: "libraries", ids: ["A"], includeLinked: false },
      }),
    );
    expect(await screen.findByText(/参考组「眼睛参考」引用的「旧库」不在这次备份里/)).toBeTruthy();
    expect(screen.getByText(/约 30\.0 MB，这次新写入 2\.0 MB（新原图 1 张）/)).toBeTruthy();
  });

  it("可以马上备份；备份进行中显示进度", async () => {
    const calls = backend((cmd) => {
      if (cmd === "backup_status") return withTarget;
      if (cmd === "backup_preview") return narrowed;
      return undefined;
    });
    render(<BackupSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "马上备份" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "start_backup")).toBe(true));
    cleanup();

    backend((cmd) => {
      if (cmd === "backup_status") return { ...withTarget, running: { done: 3, total: 10 } };
      if (cmd === "backup_preview") return narrowed;
      return undefined;
    });
    render(<BackupSettings />);
    expect(await screen.findByText("正在备份：原图 3／10")).toBeTruthy();
    expect((screen.getByRole("button", { name: "马上备份" }) as HTMLButtonElement).disabled).toBe(true);
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
    const calls = backend((cmd) => {
      if (cmd === "backup_status") return withTarget;
      if (cmd === "backup_preview") return narrowed;
      if (cmd === "backup_snapshots") return [snapshot];
      if (cmd === "restore_backup") return report;
      return undefined;
    });
    window.__KINSHOKO_TEST_PICKS__ = ["F:\\恢复"];
    render(<BackupSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "从备份恢复…" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复 2026-10-05 08:00 的快照" }));
    expect(await screen.findByText(/往返检查通过/)).toBeTruthy();
    expect(screen.getByText(/原图 12 张哈希一致/)).toBeTruthy();
    expect(screen.getByText(/主库（恢复）/)).toBeTruthy();
    expect(calls.find((c) => c.cmd === "restore_backup")?.args).toEqual({
      snapshotId: snapshot.id,
      into: "F:\\恢复",
    });
  });
});

describe("备份提醒", () => {
  it("备份目标不在时提醒，下次再试", async () => {
    backend((cmd) =>
      cmd === "backup_status"
        ? {
            ...withTarget,
            plan: {
              ...withTarget.plan,
              lastFailure: { at, reason: "备份目标不在：E:\\备份。请接上移动盘", targetUnavailable: true },
            },
          }
        : undefined,
    );
    render(<BackupReminder />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/备份没有完成.*下次退出或空闲时再试/);
    expect(alert.textContent).toMatch(/请接上移动盘/);
  });

  it("没有失败时不打扰", async () => {
    const calls = backend((cmd) => (cmd === "backup_status" ? withTarget : undefined));
    render(<BackupReminder />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "backup_status")).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
