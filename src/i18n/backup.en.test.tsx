import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { i18n } from ".";
import type { BackupStatus } from "../bindings/BackupStatus";
import type { PinGate } from "../bindings/PinGate";
import { BackupReminder, BackupSettings } from "../settings/Backup";
import { ApplicationSettingsBackup } from "../settings/ApplicationSettingsBackup";
import { FidelityGate } from "../fidelity/FidelityGate";
import { PinGateSection, pinGateMarkdown } from "../fidelity/pinGate";
import { expectNoChinese } from "../test/noChinese";
import { fakeBackend } from "../test/backend";

// 英文界面下备份与恢复、偏好设置备份、备份提醒与还原度门槛实验没有中文界面文案（#357）。
// 图库名、参考组名与路径是画师的数据；备份失败的原因来自后端。
beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  delete window.__KINSHOKO_TEST_PICKS__;
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const at = { unixMs: 1_791_158_400_000, offsetMinutes: 480 };
const status: BackupStatus = {
  plan: { target: "E:/backup", selection: { kind: "libraries", ids: ["A"], includeLinked: true }, lastSuccess: at, lastSnapshot: "s1",
    lastFailure: { at, reason: "drive missing", targetUnavailable: false }, due: false },
  running: null,
  lastReport: null,
};
const data = ["主库（恢复）", "主库", "旧库", "眼睛参考"];

function backend() {
  fakeBackend({
    registered_libraries: [{ library: { id: "A", name: "主库", root: "D:/a" }, unavailable: null }],
    backup_status: status,
    backup_preview: {
      scope: {
        libraries: [{ id: "A", name: "主库" }], groups: [{ id: "g1", name: "眼睛参考" }], steps: [],
        uncovered: [{ kind: "library", group: { id: "g1", name: "眼睛参考" }, libraryId: "B", libraryName: "旧库" }],
      },
      estimate: { totalBytes: 30 * 1024 * 1024, newBytes: 2 * 1024 * 1024, originals: 12, newOriginals: 1, unavailable: [] },
      targetAvailable: false,
    },
    backup_snapshots: [{ id: "s1", createdAt: at, libraries: [{ id: "A", name: "主库" }], groups: [{ id: "g1", name: "眼睛参考" }], skipped: [] }],
    restore_backup: {
      snapshotId: "s1",
      libraries: [{ oldId: "A", library: { id: "A2", name: "主库（恢复）", root: "F:/r" } }],
      groups: [{ oldId: "g1", id: "g2", name: "眼睛参考" }],
      check: { originals: { checked: 12, problems: [] }, curation: { checked: 20, problems: [] }, groups: { checked: 1, problems: [] } },
    },
    preview_application_settings: { fingerprint: "f", safeMode: false, forceSrgb: true },
  });
}

const pins: PinGate = {
  adapter: "GPU", display: "Monitor", error: null,
  items: [{ fileName: "a.png", gated: true, worstDeltaE: 0.5, mean: 0.1, p99: 1, max: 2, error: null }],
} as unknown as PinGate;

describe("英文界面：备份与画面保真检查", () => {
  it("图库备份：位置、上次结果、范围与恢复结果", async () => {
    backend();
    window.__KINSHOKO_TEST_PICKS__ = ["F:/r"];
    render(<BackupSettings />);
    await settle();
    expect(await screen.findByText(/About 30 MB in total, 2 MB newly written this time \(1 new original\)/)).toBeTruthy();
    expectNoChinese(document.body, data);
    fireEvent.click(screen.getByRole("button", { name: "Choose a backup…" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Restore the backup from/ }));
    expect(await screen.findByText("Complete")).toBeTruthy();
    expectNoChinese(document.body, data);
  });

  it("偏好设置备份：读取后确认替换", async () => {
    backend();
    render(<ApplicationSettingsBackup restore={async () => { throw new Error("unused"); }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Preferences backup file" }), { target: { value: "C:/b.kinshoko-settings" } });
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(await screen.findByRole("group", { name: "Replace preferences" })).toBeTruthy();
    expectNoChinese(document.body);
  });

  it("备份没有完成的通知", async () => {
    backend();
    render(<BackupReminder />);
    expect(await screen.findByText("Backup didn't finish: drive missing")).toBeTruthy();
    expectNoChinese(document.body);
  });

  it("还原度门槛实验：页面与报告里的钉图一节", async () => {
    fakeBackend({ gate_plan: () => new Promise(() => {}) });
    render(<FidelityGate />);
    expect(screen.getByRole("heading", { name: "Color fidelity gate" })).toBeTruthy();
    render(<PinGateSection pins={pins} />);
    expectNoChinese(document.body);
    const report = pinGateMarkdown(pins).join("\n");
    expect(report).toContain("Verdict: Passed; adapter: GPU; display: Monitor");
    expect(/[\u3400-\u9fff\uff00-\uffef]/.test(report)).toBe(false);
  });
});
