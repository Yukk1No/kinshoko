import { describe, expect, it } from "vitest";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { createLibraryParentPrefill, importPrefill, newLibraryParentPrefill } from "./savePrefill";

const provider = (id: string, root: string, { unavailable = false, folders = [] as string[] } = {}) =>
  ({
    registration: { library: { id, name: id, root }, unavailable: unavailable ? { code: "unavailable" } : null },
    sidebar: unavailable ? null : { folders: folders.map((folder) => ({ id: folder, name: folder, children: [] })) },
  }) as unknown as WorkspaceDirectory;

const a = provider("A", "D:/参考/甲", { folders: ["fa"] });
const b = provider("B", "E:/收藏/乙", { folders: ["fb"] });
const offline = provider("C", "F:/移动盘/丙", { unavailable: true });
const inLibrary = (libraryId: string, scope: object) => ({ kind: "library", libraryId, scope }) as WorkspaceScope;

describe("导入预填（ADR-0016）", () => {
  it("在文件夹里导入用这个文件夹，比上次选的优先", () => {
    const remembered = { libraryId: "A", folderId: "fa" };
    expect(importPrefill(inLibrary("B", { kind: "folder", id: "fb" }), remembered, [a, b])).toEqual({
      libraryId: "B",
      folderId: "fb",
    });
    expect(importPrefill(inLibrary("B", { kind: "folderTree", id: "fb" }), remembered, [a, b])).toEqual({
      libraryId: "B",
      folderId: "fb",
    });
  });

  it.each([
    ["全部", { kind: "all" }],
    ["未归类", { kind: "unassigned" }],
    ["回收站", { kind: "trash" }],
  ])("在资料库的%s里导入放进它的未归类", (_, scope) => {
    expect(importPrefill(inLibrary("B", scope), { libraryId: "A", folderId: "fa" }, [a, b])).toEqual({
      libraryId: "B",
      folderId: null,
    });
  });

  it("「全部图片」下用上次亲手选的保存目标", () => {
    expect(importPrefill({ kind: "all" }, { libraryId: "B", folderId: "fb" }, [a, b])).toEqual({
      libraryId: "B",
      folderId: "fb",
    });
  });

  it("记住的文件夹已删除时落到那个资料库的未归类", () => {
    expect(importPrefill({ kind: "all" }, { libraryId: "B", folderId: "已删" }, [a, b])).toEqual({
      libraryId: "B",
      folderId: null,
    });
  });

  it("记住的资料库暂时不可用或没记过时，落到登记最早的可用资料库的未归类", () => {
    expect(importPrefill({ kind: "all" }, { libraryId: "C", folderId: null }, [offline, a, b])).toEqual({
      libraryId: "A",
      folderId: null,
    });
    expect(importPrefill({ kind: "all" }, null, [offline, a, b])).toEqual({ libraryId: "A", folderId: null });
  });

  it("一个可用资料库都没有时留空", () => {
    expect(importPrefill({ kind: "all" }, null, [offline])).toBeNull();
    expect(importPrefill({ kind: "all" }, null, [])).toBeNull();
  });
});

describe("新建榜单资料库的位置（ADR-0016）", () => {
  it("已有榜单订阅所在资料库的旁边，后订的优先", () => {
    expect(newLibraryParentPrefill(["A", "B"], "G:/上次", [a, b])).toBe("E:/收藏");
  });

  it("榜单订阅的资料库不可用时跳过", () => {
    expect(newLibraryParentPrefill(["A", "C"], "G:/上次", [a, offline])).toBe("D:/参考");
  });

  it("没有榜单订阅时用上次新建资料库的位置", () => {
    expect(newLibraryParentPrefill([], "G:/上次", [a, b])).toBe("G:/上次");
  });

  it("都没有时放在登记最早的可用资料库旁边", () => {
    expect(newLibraryParentPrefill([], null, [offline, b, a])).toBe("E:/收藏");
  });

  it("没有可用资料库时留空，由画师选", () => {
    expect(newLibraryParentPrefill([], null, [offline])).toBeNull();
  });
});

describe("新建图库的位置", () => {
  it("用上次新建资料库的位置", () => {
    expect(createLibraryParentPrefill("G:/上次", [a, b], "C:/图片")).toBe("G:/上次");
  });

  it("没有记忆时放在登记最早的可用资料库旁边", () => {
    expect(createLibraryParentPrefill(null, [offline, b, a], "C:/图片")).toBe("E:/收藏");
  });

  it("没有可用资料库时用系统的图片文件夹", () => {
    expect(createLibraryParentPrefill(null, [offline], "C:/图片")).toBe("C:/图片");
  });

  it("图片文件夹也取不到时留空，由画师选", () => {
    expect(createLibraryParentPrefill(null, [], null)).toBeNull();
  });
});
