import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExactToggle } from "./ExactToggle";

afterEach(cleanup);

it("关闭时表示含相近，按下改为仅精确", () => {
  const onChange = vi.fn();
  render(<ExactToggle exact={false} onChange={onChange} />);
  const toggle = screen.getByRole("button", { name: "精确查找", pressed: false });
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);
});

it("开启时表示仅精确，再按一次回到含相近", () => {
  const onChange = vi.fn();
  render(<ExactToggle exact onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "精确查找", pressed: true }));
  expect(onChange).toHaveBeenCalledWith(false);
});

it("是可用 Tab 聚焦的原生按钮，Enter／空格由按钮本身处理", () => {
  render(<ExactToggle exact={false} onChange={() => {}} />);
  const toggle = screen.getByRole("button", { name: "精确查找" });
  expect(toggle.tagName).toBe("BUTTON");
  expect(toggle.getAttribute("type")).toBe("button");
  expect(toggle.tabIndex).toBe(0);
  act(() => toggle.focus());
  expect(document.activeElement).toBe(toggle);
});

it("键盘聚焦时浮出提示，只写名称；开 / 关由按下状态表达（设计系统 v2）", async () => {
  render(<ExactToggle exact={false} onChange={() => {}} />);
  const toggle = screen.getByRole("button", { name: "精确查找" });
  act(() => toggle.focus());
  expect((await screen.findAllByText("精确查找")).length).toBeGreaterThan(0);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
});
