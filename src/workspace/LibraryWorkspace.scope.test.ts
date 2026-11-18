// 没有“含子文件夹”开关以后（#608），从哪里来的文件夹范围都连同子文件夹。
import { expect, it } from "vitest";
import { withSubfolders } from "./LibraryWorkspace";

it("只看文件夹本身的范围换成整支，其他范围不变", () => {
  expect(withSubfolders({ kind: "library", libraryId: "L", scope: { kind: "folder", id: "F" } })).toEqual({
    kind: "library",
    libraryId: "L",
    scope: { kind: "folderTree", id: "F" },
  });
  const trash = { kind: "library", libraryId: "L", scope: { kind: "trash" } } as const;
  expect(withSubfolders(trash)).toBe(trash);
  expect(withSubfolders({ kind: "all" })).toEqual({ kind: "all" });
});
