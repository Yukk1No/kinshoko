import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { readImportPreview } from "./ipc";

afterEach(clearMocks);

it("只从本次预览Channel组合字节，不把命令确认体当作内容", async () => {
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:library|read_import_preview") return;
    const channel = (args as { onChunk?: Channel<ArrayBuffer> }).onChunk;
    channel?.onmessage(new Uint8Array([137, 80]).buffer);
    channel?.onmessage(new Uint8Array([78, 71]).buffer);
    channel?.onmessage(new ArrayBuffer(0));
    return [9, 9];
  });
  expect([...await readImportPreview("receipt-session", "opaque-item")]).toEqual([137, 80, 78, 71]);
});

it("已排队的字节在命令撤销时也不能成功返回", async () => {
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:library|read_import_preview") return;
    const channel = (args as { onChunk?: Channel<ArrayBuffer> }).onChunk;
    channel?.onmessage(new Uint8Array([137, 80]).buffer);
    channel?.onmessage(new ArrayBuffer(0));
    throw new Error("lens changed");
  });
  await expect(readImportPreview("receipt-session", "opaque-item")).rejects.toThrow("lens changed");
});
