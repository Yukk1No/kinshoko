import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { i18n } from ".";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import { TagGroupsPane } from "../library/TagGroupsPane";
import { languageName, sourceLanguages } from "../tags/languages";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下“编辑分组”与标签语言名没有中文界面文案（#356）；分组名、标签名、图库名是画师的数据。
beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  cleanup();
  await act(async () => {});
  clearMocks();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

const blue = { id: "b", namespace: "general" as const, name: "蓝发", untranslated: false, hasExternal: true };
const groups: CatalogGroupView[] = [
  { id: "G1", name: "发色", namespace: null, tags: [{ tag: blue, count: 1 }], sources: [{ libraryId: "A", libraryName: "角色参考", groupId: "g", groupName: "发色" }] },
  { id: "G2", name: "作品", namespace: "work", tags: [], sources: [] },
];

describe("英文界面：编辑分组", () => {
  it("分组、成员、新建与删除确认", async () => {
    mockIPC((cmd) => (cmd === "plugin:library|shared_tag_groups" ? groups : null), { shouldMockEvents: true });
    render(<TagGroupsPane safe generation={0} onBrowse={vi.fn()} onError={vi.fn()} />);
    const group = await screen.findByRole("group", { name: "发色" });
    expect(within(group).getByRole("button", { name: "发色 (1 tag)" })).toBeTruthy();
    expect(screen.getByText("All works")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New tag group" }));
    expectNoChinese(document.body, ["发色", "蓝发", "作品", "角色参考"]);
    fireEvent.click(within(group).getByRole("button", { name: "Delete tag group “发色”" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expectNoChinese(document.body, ["发色", "蓝发", "作品", "角色参考"]);
  });

  it("标签语言名用各语言的自称，未注明语言随界面语言", () => {
    expect(languageName("zh-CN")).toBe("简体中文");
    expect(languageName("fr")).toBe("fr");
    expect(sourceLanguages().at(-1)).toEqual(["und", "Language not specified"]);
  });
});
