// 给尚未翻译的标签起名（#182）：详情面板里“文/A”图标是按钮，就地弹框保存当前界面语言的名称偏好。
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagLabel } from "../bindings/TagLabel";
import { OpenTagNameSettings } from "../tags/TagNameSettings";
import { TagPanel } from "./TagPanel";

afterEach(() => { cleanup(); clearMocks(); });

const label = (id: string, name: string, untranslated = false): TagLabel => ({ id, namespace: "general", name, untranslated, hasExternal: true });
const image = (ahoge: TagLabel): ImageTags => ({ imageId: "a", tags: [{ tag: ahoge, origins: [{ kind: "source", source: "model:pixai", score: 0.64 }] }], rejected: [] });
const catalogTag = (id: string, zh: string | null, external: string) => ({ id, namespace: "general", names: zh ? [{ lang: "zh-CN", name: zh }] : [], defaultNames: zh ? [{ lang: "zh-CN", name: zh }] : [],
  namePreferences: [] as { lang: string; name: string }[], aliases: [], external: [{ vocabulary: "danbooru", name: external }] });

/** 后端：一张图一个尚未翻译的标签；保存名称偏好后它按新名字显示。 */
function backend() {
  const state = { name: null as string | null, edits: [] as unknown[] };
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|catalog_image_tags") {
      const tag = state.name ? label("t-ahoge", state.name) : label("t-ahoge", "ahoge", true);
      return { image: image(tag), identities: [{ localTagId: "t-ahoge", catalogId: "c-ahoge", tag }] };
    }
    if (cmd === "plugin:library|inspect_tag_catalog") return { libraries: [], catalog: { revision: 1, mappings: [], tags: [catalogTag("c-ahoge", null, "ahoge"), catalogTag("c-other", "阿呆毛", "other_hair")] } };
    if (cmd === "plugin:library|edit_tag_name") {
      state.edits.push(args);
      state.name = (args as { edit: { name: { name: string } } }).edit.name.name;
      return { libraries: [], catalog: { revision: 2, mappings: [], tags: [] } };
    }
    return null;
  });
  return state;
}

const chips = () => screen.getByRole("list", { name: "有效标签" });

it("点“文/A”打开改名框，保存当前界面语言的名称偏好，之后标签按新名字显示、不再有“文/A”", async () => {
  const state = backend();
  render(<TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} />);
  const button = await screen.findByRole("button", { name: "给“ahoge”改名" });
  expect(button.getAttribute("title")).toBe("尚未翻译 · 点击改名");
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "给“ahoge”改名" });
  expect(dialog.textContent).toContain("词表更新不会替换这个名字，可以在设置里恢复默认");
  expect(dialog.textContent).not.toContain("简体中文");
  const input = within(dialog).getByRole("textbox", { name: "显示名" });
  expect(input.getAttribute("placeholder")).toBeNull();
  const save = within(dialog).getByRole("button", { name: "保存显示名" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "  呆毛 " } });
  fireEvent.click(save);
  await waitFor(() => expect(within(chips()).getByText("呆毛")).toBeTruthy());
  expect(state.edits).toEqual([{ catalogId: "c-ahoge", edit: { kind: "prefer", name: { lang: "zh-CN", name: "呆毛" } } }]);
  expect(screen.queryByRole("button", { name: /改名/ })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "给“ahoge”改名" })).toBeNull();
});

it("和另一个标签的显示名相同时提示两者仍是不同的标签，但仍可保存", async () => {
  const state = backend();
  render(<TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "给“ahoge”改名" }));
  const dialog = await screen.findByRole("dialog", { name: "给“ahoge”改名" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "显示名" }), { target: { value: "阿呆毛" } });
  await within(dialog).findByText("已有标签叫“阿呆毛”，两者仍是不同的标签");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存显示名" }));
  await waitFor(() => expect(state.edits).toHaveLength(1));
  expect((state.edits[0] as { catalogId: string }).catalogId).toBe("c-ahoge");
});

it("取消不保存", async () => {
  const state = backend();
  render(<TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "给“ahoge”改名" }));
  const dialog = await screen.findByRole("dialog", { name: "给“ahoge”改名" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "显示名" }), { target: { value: "呆毛" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "给“ahoge”改名" })).toBeNull());
  expect(state.edits).toEqual([]);
});

it("弹框里的链接打开设置的显示名，并定位到这个标签", async () => {
  backend();
  const open = vi.fn();
  render(<OpenTagNameSettings.Provider value={open}><TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} /></OpenTagNameSettings.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "给“ahoge”改名" }));
  const dialog = await screen.findByRole("dialog", { name: "给“ahoge”改名" });
  fireEvent.click(within(dialog).getByRole("button", { name: "在设置中管理“ahoge”的名称和别名" }));
  expect(open).toHaveBeenCalledWith("c-ahoge");
});

it("之后词表更新、标签重新读取时，仍显示画师起的名字", async () => {
  const state = backend();
  const { rerender } = render(<TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "给“ahoge”改名" }));
  const dialog = await screen.findByRole("dialog", { name: "给“ahoge”改名" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "显示名" }), { target: { value: "呆毛" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存显示名" }));
  await waitFor(() => expect(within(chips()).getByText("呆毛")).toBeTruthy());
  // 词表变化事件让代次递增：重新读取后名字不变，“文/A”也不回来。
  rerender(<TagPanel libraryId="L1" ids={["a"]} safe={false} generation={1} onError={() => {}} />);
  await waitFor(() => expect(within(chips()).getByText("呆毛")).toBeTruthy());
  expect(screen.queryByRole("button", { name: /改名/ })).toBeNull();
  expect(state.edits).toHaveLength(1);
});
