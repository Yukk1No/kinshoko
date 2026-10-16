import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createRef } from "react";
import { ImportMenu, type ImportControl } from "./ImportMenu";

afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); clearMocks(); });

it("图片墙右键的“导入 ▸”与导入按钮走同一入口：选图片文件、选文件夹", async () => {
  mockWindows("main");
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "plugin:library|import_tasks") return [];
    if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:library|pick_files") return [];
    if (cmd === "plugin:library|pick_folder") return null;
    return undefined;
  });
  const control = createRef<ImportControl>();
  render(<ImportMenu control={control} enabled libraryId="L1" libraryName="参考" running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} />);
  await waitFor(() => expect(control.current).not.toBeNull());
  await act(async () => control.current!.files());
  await waitFor(() => expect(calls).toContain("plugin:library|pick_files"));
  await act(async () => control.current!.folder());
  await waitFor(() => expect(calls).toContain("plugin:library|pick_folder"));
});
