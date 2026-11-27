import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { LegacyNameDecision } from "../bindings/LegacyNameDecision";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import { fakeBackend } from "../test/backend";
import { acceptTagCatalog, useLegacyNamesPlan, useLegacyNamesPreview, useTagCatalog } from "./tagCatalogMirrors";

const catalog = (revision: number): TagCatalogWorkspace => ({
  libraries: [],
  catalog: { revision, tags: [], mappings: [] },
});

const legacyPlan = (revision: number, groups = 0): LegacyNameMigrationWorkspace => ({
  libraries: [],
  plan: {
    revision,
    groups: Array.from({ length: groups }, (_, index) => ({
      catalogId: `catalog-${index}`,
      namespace: "general",
      lang: "zh-CN",
      defaultName: null,
      existingPreference: null,
      affectedLibraries: [],
      sources: [],
    })),
  },
});

const registration = (id: string, unavailable: LibraryRegistration["unavailable"] = null): LibraryRegistration => ({
  library: { id, name: id, root: `D:/${id}` },
  unavailable,
});

const pause = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("统一标签目录镜像", () => {
  it("订阅者共用读取，只在词表事件后失效重读", async () => {
    let revision = 1;
    const backend = fakeBackend({ inspect_tag_catalog: () => catalog(revision) });
    const first = renderHook(() => useTagCatalog(true));
    const second = renderHook(() => useTagCatalog(true));
    await vi.waitFor(() => expect(first.result.current.value?.catalog.revision).toBe(1));
    expect(second.result.current.value?.catalog.revision).toBe(1);
    expect(backend.calls("inspect_tag_catalog")).toHaveLength(1);

    await act(async () => {
      await emit("library-event", { kind: "imagesChanged", libraryId: "a", imageIds: ["image"] });
    });
    await pause(30);
    expect(backend.calls("inspect_tag_catalog")).toHaveLength(1);

    revision = 2;
    await act(async () => {
      await emit("library-event", { kind: "vocabularyChanged", libraryId: "a", revision: 2 });
    });
    await vi.waitFor(() => expect(first.result.current.value?.catalog.revision).toBe(2));
    expect(second.result.current.value?.catalog.revision).toBe(2);
    expect(backend.calls("inspect_tag_catalog")).toHaveLength(2);
    first.unmount();
    second.unmount();
  });

  it("enabled 为 false 时不读；写入成功后 accept 直接交付，不再重读", async () => {
    const backend = fakeBackend({ inspect_tag_catalog: () => catalog(1) });
    const view = renderHook(({ enabled }) => useTagCatalog(enabled), { initialProps: { enabled: false } });
    await pause(30);
    expect(backend.calls("inspect_tag_catalog")).toHaveLength(0);

    view.rerender({ enabled: true });
    await vi.waitFor(() => expect(view.result.current.value?.catalog.revision).toBe(1));
    act(() => acceptTagCatalog(catalog(9)));
    expect(view.result.current.value?.catalog.revision).toBe(9);
    expect(backend.calls("inspect_tag_catalog")).toHaveLength(1);
    view.unmount();
  });
});

describe("名称来源待处理计划镜像", () => {
  it("订阅者共用读取，词表事件按 200ms 合并", async () => {
    const backend = fakeBackend({ plan_legacy_names: () => legacyPlan(1, 1) });
    const first = renderHook(() => useLegacyNamesPlan(true));
    const second = renderHook(() => useLegacyNamesPlan(true));
    await vi.waitFor(() => expect(first.result.current.value?.plan.groups).toHaveLength(1));
    expect(second.result.current.value?.plan.groups).toHaveLength(1);
    expect(backend.calls("plan_legacy_names")).toHaveLength(1);

    await act(async () => {
      await emit("library-event", { kind: "vocabularyChanged", libraryId: "a", revision: 2 });
    });
    await pause(100);
    expect(backend.calls("plan_legacy_names")).toHaveLength(1);
    await act(async () => {
      await emit("library-event", { kind: "vocabularyChanged", libraryId: "a", revision: 3 });
    });
    await pause(150);
    expect(backend.calls("plan_legacy_names")).toHaveLength(2);
    first.unmount();
    second.unmount();
  });

  it("只响应词表变化与任务完成；退订后清掉等待中的重读", async () => {
    const backend = fakeBackend({ plan_legacy_names: () => legacyPlan(1) });
    const view = renderHook(() => useLegacyNamesPlan(true));
    await vi.waitFor(() => expect(view.result.current.value).not.toBeNull());
    for (const event of [
      { kind: "imagesChanged", libraryId: "a", imageIds: ["image"] },
      { kind: "safeModeChanged", libraryId: "a", on: true },
    ]) {
      await act(async () => {
        await emit("library-event", event);
      });
    }
    await pause(250);
    expect(backend.calls("plan_legacy_names")).toHaveLength(1);

    await act(async () => {
      await emit("library-event", { kind: "taskFinished", libraryId: "a", taskId: "task", report: {} });
    });
    await pause(250);
    expect(backend.calls("plan_legacy_names")).toHaveLength(2);

    await act(async () => {
      await emit("library-event", { kind: "vocabularyChanged", libraryId: "a", revision: 2 });
    });
    view.unmount();
    await pause(250);
    expect(backend.calls("plan_legacy_names")).toHaveLength(2);
  });

  it("登记签名不变的工作区修订不重读；登记或可用状态变化才重读", async () => {
    const backend = fakeBackend({ plan_legacy_names: () => legacyPlan(1) });
    const view = renderHook(() => useLegacyNamesPlan(true));
    await vi.waitFor(() => expect(view.result.current.value).not.toBeNull());
    await act(async () => {
      await emit("workspace-changed", { revision: "r1", libraries: [registration("a")] });
    });
    await pause(250);
    const settled = backend.calls("plan_legacy_names").length;
    expect(settled).toBeGreaterThan(1);

    await act(async () => {
      await emit("workspace-changed", { revision: "r2", libraries: [registration("a")] });
      await emit("workspace-changed", { revision: "r3", libraries: [registration("a")] });
    });
    await pause(250);
    expect(backend.calls("plan_legacy_names")).toHaveLength(settled);

    await act(async () => {
      await emit("workspace-changed", { revision: "r4", libraries: [registration("a"), registration("b")] });
    });
    await pause(250);
    expect(backend.calls("plan_legacy_names")).toHaveLength(settled + 1);

    await act(async () => {
      await emit("workspace-changed", {
        revision: "r5",
        libraries: [registration("a"), registration("b", { code: "message", message: "offline" })],
      });
    });
    await pause(250);
    expect(backend.calls("plan_legacy_names")).toHaveLength(settled + 2);
    view.unmount();
  });

  it("安全模式切换导致的过期读取按镜像统一策略重试", async () => {
    let calls = 0;
    const backend = fakeBackend({
      plan_legacy_names: () => {
        calls++;
        if (calls === 1) throw { code: "nameMigrationSafeModeChanged" };
        return legacyPlan(calls);
      },
    });
    const view = renderHook(() => useLegacyNamesPlan(true));
    await vi.waitFor(() => expect(view.result.current.value?.plan.revision).toBe(2), { timeout: 2000 });
    expect(backend.calls("plan_legacy_names")).toHaveLength(2);
    view.unmount();
  });
});

describe("旧名称预览镜像", () => {
  it("按修订与整套选择建键；选择变化后重新预览", async () => {
    const follow: LegacyNameDecision[] = [
      { catalogId: "shared", lang: "zh-CN", resolution: { kind: "followDefault" } },
    ];
    const keep: LegacyNameDecision[] = [{ catalogId: "shared", lang: "zh-CN", resolution: { kind: "keepPreference" } }];
    const backend = fakeBackend({
      preview_legacy_names: (args) => ({
        revision: args.revision,
        outcomes: [
          {
            catalogId: "shared",
            lang: "zh-CN",
            displayName: (args.decisions as LegacyNameDecision[])[0].resolution.kind,
            preferenceName: null,
          },
        ],
      }),
    });
    const view = renderHook(({ decisions }) => useLegacyNamesPreview(7, decisions, true), {
      initialProps: { decisions: follow },
    });
    await vi.waitFor(() => expect(view.result.current.value?.outcomes[0]?.displayName).toBe("followDefault"));
    view.rerender({ decisions: keep });
    await vi.waitFor(() => expect(view.result.current.value?.outcomes[0]?.displayName).toBe("keepPreference"));
    expect(backend.calls("preview_legacy_names").map((call) => call.args.revision)).toEqual([7, 7]);
    view.unmount();
  });
});
