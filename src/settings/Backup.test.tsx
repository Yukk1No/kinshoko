import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, isInaccessible, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { BackupPreview } from "../bindings/BackupPreview";
import type { BackupStatus } from "../bindings/BackupStatus";
import type { RestoreReport } from "../bindings/RestoreReport";
import type { SnapshotSummary } from "../bindings/SnapshotSummary";
import { BackupReminder, BackupSettings } from "./Backup";
import { chooseOption } from "../test/select";
import { fakeBackend, type Replies } from "../test/backend";
import { cssRule } from "../ui/cssRule";
import settingsCss from "../ui/settings.css?raw";

afterEach(() => {
  delete window.__KINSHOKO_TEST_PICKS__;
});

const at = { unixMs: 1_791_158_400_000, offsetMinutes: 480 };

const empty: BackupStatus = {
  plan: {
    target: null,
    selection: { kind: "all" },
    lastSuccess: null,
    lastSnapshot: null,
    lastFailure: null,
    due: false,
  },
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
  estimate: {
    totalBytes: 30 * 1024 * 1024,
    newBytes: 2 * 1024 * 1024,
    originals: 12,
    newOriginals: 1,
    unavailable: [],
  },
  targetAvailable: true,
};

/** 备份设置的假后端：两个已登记的图库，其余照 `replies`。 */
const backend = (replies: Replies) => fakeBackend({ registered_libraries: registrations, ...replies });

describe("设置：备份", () => {
  it.each([false, true])(
    "coalesces rapid selections before starting a manual backup (start requested: %s)",
    async (startRequested) => {
      const initial: BackupStatus = {
        ...withTarget,
        plan: { ...withTarget.plan, selection: { kind: "libraries", ids: [], includeLinked: true } },
      };
      const saves: Array<() => void> = [];
      const fake = backend({
        backup_status: initial,
        backup_preview: narrowed,
        start_backup: null,
        set_backup_selection: (args) =>
          new Promise<BackupStatus>((resolve) => {
            saves.push(() =>
              resolve({
                ...initial,
                plan: { ...initial.plan, selection: args.selection as BackupStatus["plan"]["selection"] },
              }),
            );
          }),
      });
      render(<BackupSettings />);
      const a = await screen.findByRole<HTMLInputElement>("checkbox", { name: "主库" });
      const b = screen.getByRole<HTMLInputElement>("checkbox", { name: "旧库" });
      fireEvent.click(a);
      await waitFor(() => expect(saves).toHaveLength(1));
      fireEvent.click(b);
      expect(a.checked).toBe(true);
      expect(b.checked).toBe(true);
      if (startRequested) fireEvent.click(screen.getByRole("button", { name: "备份" }));
      await act(() => emit("backup-status", initial));
      expect(saves).toHaveLength(1);
      expect(fake.calls("start_backup")).toHaveLength(0);
      expect(a.checked).toBe(true);
      expect(b.checked).toBe(true);
      await act(async () => saves[0]());
      await waitFor(() => expect(saves).toHaveLength(2));
      expect(fake.calls("start_backup")).toHaveLength(0);
      expect(a.checked).toBe(true);
      expect(b.checked).toBe(true);
      await act(async () => saves[1]());
      if (startRequested) await waitFor(() => expect(fake.calls("start_backup")).toHaveLength(1));
      expect(fake.calls("set_backup_selection").at(-1)?.args).toEqual({
        selection: { kind: "libraries", ids: ["A", "B"], includeLinked: true },
      });
      expect(a.checked).toBe(true);
      expect(b.checked).toBe(true);
    },
  );

  it("rolls back a failed selection save and allows retrying an empty selection", async () => {
    const initial: BackupStatus = {
      ...withTarget,
      plan: { ...withTarget.plan, selection: { kind: "libraries", ids: [], includeLinked: true } },
    };
    const fake = backend({
      backup_status: initial,
      backup_preview: narrowed,
      set_backup_selection: () => {
        throw new Error("save unavailable");
      },
    });
    render(<BackupSettings />);
    const a = await screen.findByRole<HTMLInputElement>("checkbox", { name: "主库" });
    fireEvent.click(a);
    await screen.findByRole("alert");
    expect(a.checked).toBe(false);
    fake.on("set_backup_selection", (args) => ({ ...initial, plan: { ...initial.plan, selection: args.selection } }));
    fireEvent.click(a);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(a.checked).toBe(true);
    fireEvent.click(a);
    await waitFor(() =>
      expect(fake.calls("set_backup_selection").at(-1)?.args).toEqual({
        selection: { kind: "libraries", ids: [], includeLinked: true },
      }),
    );
    expect(a.checked).toBe(false);
  });

  it.each([
    [false, "会跳过"],
    [true, "备份无法完成"],
  ])("预览区分部分图库和全部图库无法读取（全部：%s）", async (allUnavailable, expected) => {
    const library = { id: "A", name: "主库" };
    backend({
      backup_status: withTarget,
      backup_preview: {
        ...narrowed,
        scope: {
          ...narrowed.scope,
          libraries: allUnavailable ? [library] : [library, { id: "B", name: "旧库" }],
        },
        estimate: { ...narrowed.estimate, unavailable: [{ library, reason: "暂时离线" }] },
      },
    });
    render(<BackupSettings />);
    expect(await screen.findByText(`「主库」暂时无法读取，${expected}：暂时离线`)).toBeTruthy();
  });

  it("备份结束后重新估计容量，进度事件不重复估计", async () => {
    const fake = backend({ backup_status: withTarget, backup_preview: narrowed });
    render(<BackupSettings />);
    await screen.findByText(/新原图 1 张/);
    for (const done of [0, 3, 10]) {
      await act(() => emit("backup-status", { ...withTarget, running: { done, total: 12 } }));
    }
    expect(fake.calls("backup_preview")).toHaveLength(1);
    let resolve!: (preview: BackupPreview) => void;
    fake.on(
      "backup_preview",
      () =>
        new Promise<BackupPreview>((r) => {
          resolve = r;
        }),
    );
    await act(() => emit("backup-status", withTarget));
    await waitFor(() => expect(fake.calls("backup_preview")).toHaveLength(2));
    expect(screen.queryByText(/新原图 1 张/)).toBeNull();
    await act(async () =>
      resolve({ ...narrowed, estimate: { ...narrowed.estimate, newBytes: 524288, newOriginals: 0 } }),
    );
    expect(await screen.findByText(/这次新写入 512 KB（新原图 0 张）/)).toBeTruthy();
  });

  it.each([null, new Error("preview unavailable")])("备份失败后估计返回 %s 时不保留旧容量", async (reply) => {
    const fake = backend({ backup_status: withTarget, backup_preview: narrowed });
    render(<BackupSettings />);
    await screen.findByText(/新原图 1 张/);
    await act(() => emit("backup-status", { ...withTarget, running: { done: 1, total: 12 } }));
    fake.on("backup_preview", () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    await act(() =>
      emit("backup-status", {
        ...withTarget,
        plan: { ...withTarget.plan, lastFailure: { at, reason: "interrupted", targetUnavailable: false } },
      }),
    );
    await waitFor(() => expect(fake.calls("backup_preview")).toHaveLength(2));
    expect(screen.queryByText(/新原图 1 张/)).toBeNull();
    if (reply instanceof Error) expect(await screen.findAllByRole("alert")).toHaveLength(2);
  });

  it("备份前尚未返回的估计不能覆盖结束后的估计", async () => {
    let resolve!: (preview: BackupPreview) => void;
    const fake = backend({
      backup_status: withTarget,
      backup_preview: () =>
        new Promise<BackupPreview>((r) => {
          resolve = r;
        }),
    });
    render(<BackupSettings />);
    await waitFor(() => expect(fake.calls("backup_preview")).toHaveLength(1));
    await act(() => emit("backup-status", { ...withTarget, running: { done: 1, total: 12 } }));
    fake.on("backup_preview", { ...narrowed, estimate: { ...narrowed.estimate, newBytes: 524288, newOriginals: 0 } });
    await act(() => emit("backup-status", withTarget));
    await screen.findByText(/新原图 0 张/);
    await act(async () => resolve(narrowed));
    expect(screen.queryByText(/新原图 1 张/)).toBeNull();
    expect(screen.getByText(/新原图 0 张/)).toBeTruthy();
  });

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

  it("重新估算时保留旧预览并降低文字强调度，直到新结果返回", async () => {
    const selected: BackupStatus = {
      ...withTarget,
      plan: { ...withTarget.plan, selection: { kind: "libraries", ids: ["A"], includeLinked: true } },
    };
    const fake = backend({
      backup_status: selected,
      set_backup_selection: (args) => ({ ...selected, plan: { ...selected.plan, selection: args.selection } }),
      backup_preview: narrowed,
    });
    render(
      <div className="k-settings">
        <BackupSettings />
      </div>,
    );
    const oldEstimate = await screen.findByText(/新原图 1 张/);
    const preview = screen.getByRole("group", { name: "备份内容" });
    const mutedSelector = '.k-settings .backup-preview[aria-hidden="true"]';
    let resolve!: (preview: BackupPreview) => void;
    fake.on(
      "backup_preview",
      () =>
        new Promise<BackupPreview>((r) => {
          resolve = r;
        }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "旧库" }));
    const estimating = await screen.findByText("正在估算…");
    expect(fake.calls("backup_preview").at(-1)?.args).toEqual({
      selection: { kind: "libraries", ids: ["A", "B"], includeLinked: true },
    });
    expect(oldEstimate.isConnected).toBe(true);
    expect(getComputedStyle(preview).visibility).toBe("visible");
    expect(screen.queryByRole("group", { name: "备份内容" })).toBeNull();
    expect(isInaccessible(oldEstimate)).toBe(true);
    expect(isInaccessible(estimating)).toBe(false);
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview.matches(mutedSelector)).toBe(true);
    expect(cssRule(settingsCss, mutedSelector).color).toBe("color-mix(in srgb, var(--ink-2) 90%, var(--bg))");
    expect(settingsCss).not.toMatch(/\.backup-preview\s*\{[^}]*\bcolor\s*:/);

    await act(async () => resolve({ ...narrowed, estimate: { ...narrowed.estimate, newOriginals: 2 } }));
    const newEstimate = await screen.findByText(/新原图 2 张/);
    expect(newEstimate.parentElement).toBe(preview);
    expect(screen.getByRole("group", { name: "备份内容" })).toBe(preview);
    expect(isInaccessible(newEstimate)).toBe(false);
    expect(preview.getAttribute("aria-hidden")).toBeNull();
    expect(preview.matches(mutedSelector)).toBe(false);
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
      libraries: [
        { oldId: "A", library: { id: "A2", name: "主库（恢复）", root: "F:\\恢复\\主库（恢复 2026-10-06）" } },
      ],
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
  it("启动时上次备份和轻提示都只显示磁盘写满的原图合计", async () => {
    backend({
      backup_preview: narrowed,
      backup_status: {
        ...withTarget,
        plan: {
          ...withTarget.plan,
          lastFailure: {
            at,
            reason: {
              code: "backupProblems",
              problems: ["hash-1", "hash-2"].map((file) => ({
                code: "backupOriginalProblem",
                name: "主库",
                file,
                cause: { code: "backupTargetDiskFull" },
              })),
            },
            targetUnavailable: false,
          },
        },
      },
    });
    render(
      <>
        <BackupReminder />
        <BackupSettings />
      </>,
    );
    const row = (await screen.findByText("上次备份")).closest("li")!;
    const title = "备份没有完成：2 张原图未备份：备份磁盘空间不足";
    await screen.findByText(title, { selector: ".k-toast *" });
    expect(within(row).getByRole("alert").textContent).toContain("2 张原图未备份：备份磁盘空间不足");
  });

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
      backup_status: {
        ...withTarget,
        plan: { ...withTarget.plan, lastFailure: { at, reason: "备份目标不在", targetUnavailable: true } },
      },
    });
    render(
      <>
        <BackupReminder />
      </>,
    );
    const title = (await screen.findAllByText("备份没有完成：备份目标不在")).find((node) => node.closest(".k-toast"))!;
    expect(title.closest(".k-toast")?.getAttribute("data-tone")).toBe("error");
    expect(title.closest(".k-toast")?.textContent).toContain("下次退出或空闲时再试");
    expect(document.querySelectorAll(".k-toast")).toHaveLength(1);
  });

  it("提醒重新挂载时不叠出重复的出错提示", async () => {
    backend({
      backup_status: {
        ...withTarget,
        plan: { ...withTarget.plan, lastFailure: { at, reason: "备份目标不在", targetUnavailable: true } },
      },
    });
    const view = render(
      <>
        <BackupReminder key="a" />
      </>,
    );
    await waitFor(() => expect(document.querySelectorAll(".k-toast")).toHaveLength(1));
    view.rerender(
      <>
        <BackupReminder key="b" />
      </>,
    );
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
