import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import { fakeBackend } from "../test/backend";
import { useRegisteredLibraries, useWorkspaceDirectories } from "./workspaceDirectoriesMirror";

const directories = (revision: string): WorkspaceDirectories => ({
  status: { revision, libraries: [] },
  providers: [],
  registrationOrder: [],
});

describe("工作区目录镜像", () => {
  it("同一 safe 透镜的订阅者共用一份读取，工作区事件让共享镜像重读", async () => {
    let current = directories("r1");
    const backend = fakeBackend({ workspace_directories: () => current });
    const first = renderHook(() => useWorkspaceDirectories(true));
    const second = renderHook(() => useWorkspaceDirectories(true));
    await vi.waitFor(() => expect(first.result.current.value?.status.revision).toBe("r1"));
    expect(second.result.current.value?.status.revision).toBe("r1");
    expect(backend.calls("workspace_directories")).toHaveLength(1);

    current = directories("r2");
    await act(async () => {
      await emit("workspace-changed", { revision: "r2", libraries: [] });
    });
    await vi.waitFor(() => expect(first.result.current.value?.status.revision).toBe("r2"));
    expect(second.result.current.value?.status.revision).toBe("r2");
    expect(backend.calls("workspace_directories")).toHaveLength(2);
    first.unmount();
    second.unmount();
  });

  it("safe 与完整透镜分开缓存；读取过期按镜像统一策略重试", async () => {
    let calls = 0;
    const backend = fakeBackend({
      workspace_directories: () => {
        calls++;
        return calls === 1 ? Promise.reject({ code: "cursorExpired" }) : directories(`r${calls}`);
      },
    });
    const safe = renderHook(() => useWorkspaceDirectories(true));
    const full = renderHook(() => useWorkspaceDirectories(false));
    await vi.waitFor(() => expect(safe.result.current.value).not.toBeNull(), { timeout: 3000 });
    await vi.waitFor(() => expect(full.result.current.value).not.toBeNull());
    expect(backend.calls("workspace_directories").map((call) => call.args.safeMode)).toEqual([true, false, true]);
    safe.unmount();
    full.unmount();
  });

  it("资料库登记镜像直接接受工作区事件携带的完整登记", async () => {
    const library = { id: "L", name: "参考", root: "D:/参考" };
    const backend = fakeBackend({ registered_libraries: [] });
    const view = renderHook(() => useRegisteredLibraries());
    await vi.waitFor(() => expect(view.result.current.value).toEqual([]));
    const before = backend.calls("registered_libraries").length;
    const registration = { library, unavailable: null };
    await act(async () => {
      await emit("workspace-changed", { revision: "r2", libraries: [registration] });
    });
    expect(view.result.current.value).toEqual([registration]);
    expect(backend.calls("registered_libraries")).toHaveLength(before);
    view.unmount();
  });
});
