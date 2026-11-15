// 输入法选字时按下的回车、Esc 属于输入法：三个普通输入框不提交、不取消（#542）。
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NameInput } from "./NameInput";
import { NewGroup } from "../library/TagGroupsPane";
import { AliasEditor } from "../library/TagPanel";
import { ToastProvider } from "./Toast";
import { fakeBackend } from "../test/backend";

const composing: KeyboardEventInit[] = [{ isComposing: true }, { keyCode: 229 }];
const box = () => screen.getByRole("textbox");
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(box(), { key, ...init });

it("就地改名：选字时的回车和 Esc 不提交也不取消，普通回车提交", () => {
  const done = vi.fn();
  render(<NameInput label="名称" initial="旧" onDone={done} />);
  type("新名");
  for (const init of composing) {
    press("Enter", init);
    press("Escape", init);
  }
  expect(done).not.toHaveBeenCalled();
  press("Enter");
  expect(done).toHaveBeenCalledWith("新名");
});

it("新建标签分组：选字时的回车和 Esc 不提交也不取消，普通回车提交", () => {
  const done = vi.fn();
  render(<NewGroup onDone={done} />);
  type("发色");
  for (const init of composing) {
    press("Enter", init);
    press("Escape", init);
  }
  expect(done).not.toHaveBeenCalled();
  press("Enter");
  expect(done).toHaveBeenCalledWith({ name: "发色", namespace: null });
});

it("标签别名：选字时的回车和 Esc 不添加也不关闭，普通回车添加", async () => {
  const backend = fakeBackend({ vocabulary: { tags: [] }, add_tag_alias: null });
  const commands = () => backend.calls().map((call) => call.command);
  const onClose = vi.fn();
  const tag = { id: "t1", namespace: "general" as const, name: "猫", untranslated: false, hasExternal: false };
  render(
    <ToastProvider>
      <AliasEditor libraryId="L" tag={tag} generation={0} onError={() => {}} onClose={onClose} />
    </ToastProvider>,
  );
  type("小猫");
  for (const init of composing) {
    press("Enter", init);
    press("Escape", init);
  }
  expect(commands().some((c) => c.includes("alias"))).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  press("Enter");
  expect(commands().some((c) => c.includes("alias"))).toBe(true);
  press("Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
});
