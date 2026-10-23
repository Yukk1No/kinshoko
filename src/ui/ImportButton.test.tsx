import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImportButton } from "./ImportButton";

afterEach(cleanup);

const handlers = () => ({ onFiles: vi.fn(), onFolder: vi.fn(), onEagle: vi.fn() });

it("一个按钮打开菜单，在菜单里选来源：图片、文件夹、从 Eagle 导入", async () => {
  const h = handlers();
  render(<ImportButton {...h} />);
  const button = screen.getByRole("button", { name: "导入" });
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole("menuitem", { name: /^文件夹/ }));
  expect(h.onFolder).toHaveBeenCalledTimes(1);

  fireEvent.click(button);
  fireEvent.click(await screen.findByRole("menuitem", { name: /从 Eagle 导入/ }));
  expect(h.onEagle).toHaveBeenCalledTimes(1);

  fireEvent.click(button);
  const files = await screen.findByRole("menuitem", { name: /^图片/ });
  expect(files.textContent).toContain("Ctrl O");
  fireEvent.click(files);
  expect(h.onFiles).toHaveBeenCalledTimes(1);
});

it("顶栏里只留图标与箭头，菜单里不放解释性的提示行", async () => {
  render(<ImportButton {...handlers()} />);
  const button = screen.getByRole("button", { name: "导入" });
  expect(button.textContent).toBe("");
  expect(button.querySelectorAll("svg")).toHaveLength(2);
  fireEvent.click(button);
  await screen.findByRole("menuitem", { name: /^图片/ });
  expect(screen.queryByText("也可以直接拖进窗口")).toBeNull();
  expect(screen.queryByRole("note")).toBeNull();
});

it("导入进行中，按钮标明忙碌", () => {
  render(<ImportButton {...handlers()} busy onShowTasks={() => {}} />);
  expect(screen.getByRole("button", { name: "正在导入" }).getAttribute("aria-busy")).toBe("true");
});

it("导入进行中不能再开始导入，但仍能打开导入任务", async () => {
  const h = { ...handlers(), onShowTasks: vi.fn() };
  render(<ImportButton {...h} busy />);
  fireEvent.click(screen.getByRole("button", { name: "正在导入" }));
  const folder = await screen.findByRole("menuitem", { name: /^文件夹/ });
  expect(folder.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(folder);
  expect(h.onFolder).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "导入任务" }));
  expect(h.onShowTasks).toHaveBeenCalledTimes(1);
});

it("导入进行中又没有任务可看时，按钮不可用", () => {
  render(<ImportButton {...handlers()} busy />);
  expect(screen.getByRole("button", { name: "正在导入" })).toHaveProperty("disabled", true);
});
