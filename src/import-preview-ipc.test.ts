import { expect, it } from "vitest";
import type { Channel } from "@tauri-apps/api/core";
import { readImportPreview } from "./ipc";
import { fakeBackend } from "./test/backend";

it("只从本次预览Channel组合字节，不把命令确认体当作内容", async () => {
  fakeBackend({
    read_import_preview: (args) => {
      const channel = (args as { onChunk?: Channel<ArrayBuffer> }).onChunk;
      channel?.onmessage(new Uint8Array([137, 80]).buffer);
      channel?.onmessage(new Uint8Array([78, 71]).buffer);
      channel?.onmessage(new ArrayBuffer(0));
      return [9, 9];
    },
  });
  expect([...await readImportPreview("receipt-session", "opaque-item")]).toEqual([137, 80, 78, 71]);
});

it("已排队的字节在命令撤销时也不能成功返回", async () => {
  fakeBackend({
    read_import_preview: (args) => {
      const channel = (args as { onChunk?: Channel<ArrayBuffer> }).onChunk;
      channel?.onmessage(new Uint8Array([137, 80]).buffer);
      channel?.onmessage(new ArrayBuffer(0));
      throw new Error("lens changed");
    },
  });
  await expect(readImportPreview("receipt-session", "opaque-item")).rejects.toThrow("lens changed");
});
