import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { reRegister } from "./undoRemoval";

const info = (id: string) => ({ id, name: id, root: `D:\\${id}` });
let calls: string[] = [];
afterEach(() => { clearMocks(); calls = []; });
const ipc = () => mockIPC((command, args) => {
  calls.push(command);
  if (command === "plugin:library|register_library") return info("B");
  if (command === "plugin:library|switch_library") return info((args as { libraryId: string }).libraryId);
  return null;
});

it("撤销移除：重新登记后切回原来的当前图库", async () => {
  ipc();
  expect((await reRegister("D:\\B", "A")).id).toBe("A");
  expect(calls).toEqual(["plugin:library|register_library", "plugin:library|switch_library"]);
});

it("移除的就是当前图库（或没有当前图库）时，重新登记的图库就是当前图库", async () => {
  ipc();
  expect((await reRegister("D:\\B", null)).id).toBe("B");
  expect((await reRegister("D:\\B", "B")).id).toBe("B");
  expect(calls).toEqual(["plugin:library|register_library", "plugin:library|register_library"]);
});
