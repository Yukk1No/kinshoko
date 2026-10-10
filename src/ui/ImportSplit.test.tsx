import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImportSplit } from "./ImportSplit";

afterEach(cleanup);

const handlers = () => ({ onFiles: vi.fn(), onFolder: vi.fn(), onEagle: vi.fn() });

it("左半直接导入图片文件", () => {
  const h = handlers();
  render(<ImportSplit {...h} />);
  fireEvent.click(screen.getByRole("button", { name: "导入图片文件" }));
  expect(h.onFiles).toHaveBeenCalledTimes(1);
  expect(h.onFolder).not.toHaveBeenCalled();
  expect(h.onEagle).not.toHaveBeenCalled();
});

it("箭头打开其他来源：图片文件、整个文件夹、从 Eagle 导入，并提示可以拖进窗口", async () => {
  const h = handlers();
  render(<ImportSplit {...h} />);
  const more = screen.getByRole("button", { name: "更多导入方式" });
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole("menuitem", { name: /整个文件夹/ }));
  expect(h.onFolder).toHaveBeenCalledTimes(1);

  fireEvent.click(more);
  expect(await screen.findByText("也可以直接拖进窗口")).toBeTruthy();
  fireEvent.click(await screen.findByRole("menuitem", { name: /从 Eagle 导入/ }));
  expect(h.onEagle).toHaveBeenCalledTimes(1);

  fireEvent.click(more);
  fireEvent.click(await screen.findByRole("menuitem", { name: /图片文件/ }));
  expect(h.onFiles).toHaveBeenCalledTimes(1);
});

it("导入进行中不能再开始导入，但仍能打开导入任务", async () => {
  const h = { ...handlers(), onShowTasks: vi.fn() };
  render(<ImportSplit {...h} busy />);
  expect(screen.getByRole("button", { name: "导入图片文件" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "更多导入方式" }));
  const folder = await screen.findByRole("menuitem", { name: /整个文件夹/ });
  expect(folder.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(folder);
  expect(h.onFolder).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "查看导入任务" }));
  expect(h.onShowTasks).toHaveBeenCalledTimes(1);
});
