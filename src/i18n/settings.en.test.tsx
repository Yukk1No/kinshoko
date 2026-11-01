import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { i18n } from ".";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import { SettingsPanel } from "../SettingsPanel";
import { backend, resetSettingsTest, tab } from "../SettingsPanel.fixtures";
import { thresholdProblem } from "../tags/tagConfidence";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下设置各页（备份与更新另测）没有中文界面文案（#357）。图库名、标签名是画师的数据。
beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  await resetSettingsTest();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const tag = { id: "C1", namespace: "general" as const, names: [{ lang: "zh-CN", name: "蓝瞳" }], defaultNames: [{ lang: "en", name: "blue eyes" }],
  namePreferences: [{ lang: "en", name: "Blue" }], aliases: [{ lang: null, name: "碧眼" }], external: [] };
const workspace = {
  libraries: [{ library: { id: "L1", name: "工作参考", root: "D:/ref" }, unavailable: null }],
  catalog: {
    tags: [tag],
    mappings: [{ libraryId: "L1", localTagId: "t1", catalogId: "C1", basis: "external", nameProvenance: "pending",
      legacy: { namespace: "general", names: [{ lang: "zh-CN", name: "蓝瞳" }], aliases: [], external: ["blue_eyes"] }, sourceNames: [{ name: "蓝瞳", lang: "zh-CN" }] }],
  },
} as unknown as TagCatalogWorkspace;
const data = ["工作参考", "蓝瞳", "碧眼", "简体中文"];

function show() {
  backend((cmd) => {
    if (cmd === "plugin:library|inspect_tag_catalog") return workspace;
    if (cmd === "plugin:library|shared_personal_approx") return { revision: 1, entries: [], conflicts: [] };
    if (cmd === "plugin:library|shared_tag_groups") return [];
    return undefined;
  });
  render(<SettingsPanel library={null} safe onSafeMode={() => {}} />);
}

describe("英文界面：设置", () => {
  it("通用、快捷键、安全与诊断", async () => {
    show();
    await screen.findByRole("heading", { name: "General", level: 3 });
    expectNoChinese(document.body);
    await tab("Shortcuts");
    expect(screen.getByRole("listitem", { name: "Zoom" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    expectNoChinese(document.body);
    await tab("Safety");
    expect(screen.getByText("Sensitive and up")).toBeTruthy();
    expectNoChinese(document.body);
    await tab("Diagnostics");
    expectNoChinese(document.body);
  });

  it("标签：显示名、对应、相近与外观", async () => {
    show();
    await tab("Tags");
    await settle();
    const load = screen.queryByRole("button", { name: "Load tags" });
    if (load) { fireEvent.click(load); await settle(); }
    fireEvent.click(await screen.findByRole("button", { name: /^Rename/ }));
    expectNoChinese(document.body, data);
    for (const view of ["Mapping", "Similar", "Appearance"]) {
      fireEvent.click(screen.getByRole("button", { name: view }));
      await settle();
      if (view === "Mapping") { fireEvent.click(screen.getByRole("button", { name: "Check tag mapping" })); await settle(); }
      expectNoChinese(document.body, data);
    }
    expect(thresholdProblem({ high: 0.3, low: 0.5 })).toBe("The low upper bound must be less than the high lower bound");
  });

  it("自动标签", async () => {
    show();
    await tab("Auto-tagging");
    await settle();
    expect(screen.getByText("Starts once you add a library")).toBeTruthy();
    expectNoChinese(document.body);
  });
});
