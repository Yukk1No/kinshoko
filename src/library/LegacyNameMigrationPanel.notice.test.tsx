import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import { i18n } from "../i18n/instance";
import { fakeBackend } from "../test/backend";
import { LegacyNameMigrationNotice } from "./LegacyNameMigrationPanel";

const view = (): LegacyNameMigrationWorkspace => ({
  libraries: [{ library: { id: "a", name: "旧库 a", root: "C:/a" }, unavailable: null }],
  plan: { revision: 7, groups: [{ catalogId: "shared", namespace: "general", lang: "zh-CN", defaultName: "分缝发型", existingPreference: null, affectedLibraries: ["a"], sources: [{ libraryId: "a", localTagId: "local-a", legacyName: "分发", currentName: "分发" }] }] },
});

describe("主窗口的旧名称通知（#433）", () => {
  const groups = (count: number) => ({ ...view(), plan: { revision: 7, groups: Array.from({ length: count }, (_, index) => ({ ...view().plan.groups[0], catalogId: `c${index}` })) } });
  const serve = (read: () => LegacyNameMigrationWorkspace) => fakeBackend({ plan_legacy_names: () => read() });
  const dismiss = async () => {
    fireEvent.click(screen.getByRole("button", { name: "关闭提示", hidden: true }));
    await waitFor(() => expect(screen.queryByText(/旧名称待确认/)).toBeNull());
  };
  const vocabulary = () => act(async () => { await emit("library-event", { kind: "vocabularyChanged", libraryId: "a" }); });

  it("是通知，不是横幅；数量原地更新，确认完后收起", async () => {
    let count = 2;
    serve(() => groups(count));
    render(<LegacyNameMigrationNotice safe={false} enabled hidden={false} onOpen={() => {}} />);
    const title = await screen.findByText("2 个旧名称待确认");
    expect(title.closest(".k-toast")).toBeTruthy();
    count = 3;
    await vocabulary();
    expect(await screen.findByText("3 个旧名称待确认")).toBeTruthy();
    expect(document.querySelectorAll(".k-toast")).toHaveLength(1);
    count = 0;
    await vocabulary();
    await waitFor(() => expect(document.querySelector(".k-toast")).toBeNull());
  });

  it("关掉后只有超过关掉时的数量才再弹", async () => {
    let count = 2;
    serve(() => groups(count));
    render(<LegacyNameMigrationNotice safe={false} enabled hidden={false} onOpen={() => {}} />);
    await screen.findByText("2 个旧名称待确认");
    await dismiss();
    count = 1;
    await vocabulary();
    await new Promise((resolve) => setTimeout(resolve, 300));
    count = 2;
    await vocabulary();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByText(/旧名称待确认/)).toBeNull();
    count = 3;
    await vocabulary();
    expect(await screen.findByText("3 个旧名称待确认")).toBeTruthy();
  });

  it("切换安全模式时数量同步，通知不闪；关掉后来回切换也不再弹", async () => {
    let count = 3;
    serve(() => groups(count));
    const ui = (safe: boolean) => <LegacyNameMigrationNotice safe={safe} enabled hidden={false} onOpen={() => {}} />;
    const { rerender } = render(ui(false));
    await screen.findByText("3 个旧名称待确认");
    const toast = document.querySelector(".k-toast");
    count = 1;
    await act(async () => { rerender(ui(true)); await emit("safe-mode-setting", true); });
    expect(await screen.findByText("1 个旧名称待确认")).toBeTruthy();
    expect(document.querySelector(".k-toast")).toBe(toast);
    await dismiss();
    count = 1;
    await act(async () => { rerender(ui(false)); await emit("safe-mode-setting", false); });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByText(/旧名称待确认/)).toBeNull();
  });

  it("换界面语言后正在显示的通知随之更新", async () => {
    serve(() => groups(2));
    render(<LegacyNameMigrationNotice safe={false} enabled hidden={false} onOpen={() => {}} />);
    await screen.findByText("2 个旧名称待确认");
    await act(async () => { await i18n.changeLanguage("en"); });
    try {
      expect(await screen.findByText("2 older names to confirm")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Confirm one by one" })).toBeTruthy();
    } finally { await act(async () => { await i18n.changeLanguage("zh-CN"); }); }
  });

  it("还没有图库或打开着向导时不显示，向导取消后回来", async () => {
    serve(() => groups(1));
    const ui = (enabled: boolean, hidden: boolean) => <LegacyNameMigrationNotice safe={false} enabled={enabled} hidden={hidden} onOpen={() => {}} />;
    const { rerender } = render(ui(false, false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/旧名称待确认/)).toBeNull();
    rerender(ui(true, false));
    await screen.findByText("1 个旧名称待确认");
    rerender(ui(true, true));
    await waitFor(() => expect(screen.queryByText(/旧名称待确认/)).toBeNull());
    rerender(ui(true, false));
    expect(await screen.findByText("1 个旧名称待确认")).toBeTruthy();
  });
});
