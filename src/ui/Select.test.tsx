import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { Select } from "./Select";
import { chooseOption } from "../test/select";

afterEach(cleanup);

const OPTIONS = [
  { value: "name", label: "名称" },
  { value: "added", label: "添加时间" },
  { value: "size", label: "尺寸", disabled: true },
  { value: "rating", label: "分级" },
];

function Sort({ onPick = () => {} }: { onPick?: (value: string) => void }) {
  const [value, setValue] = useState("added");
  return <Select label="排序" value={value} options={OPTIONS} onChange={(next) => { setValue(next); onPick(next); }} />;
}

const trigger = () => screen.getByRole("combobox", { name: "排序" });

describe("Select", () => {
  it("触发器写着当前值，不用原生 select", () => {
    render(<Sort />);
    expect(trigger().tagName).not.toBe("SELECT");
    expect(trigger().textContent).toContain("添加时间");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("展开后列出各项，当前值在指示列放勾", async () => {
    render(<Sort />);
    fireEvent.click(trigger());
    const list = await screen.findByRole("listbox");
    expect(list.className).toContain("k-listbox");
    expect(list.closest(".k-popup")).toBeTruthy();
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["名称", "添加时间", "尺寸", "分级"]);
    const current = within(list).getByRole("option", { name: "添加时间" });
    expect(current.getAttribute("aria-selected")).toBe("true");
    expect(current.querySelector(".k-item-ind .lucide-check")).toBeTruthy();
    expect(within(list).getByRole("option", { name: "名称" }).querySelector(".lucide-check")).toBeNull();
  });

  it("点一项即选中并收起", async () => {
    const picked: string[] = [];
    render(<Sort onPick={(v) => picked.push(v)} />);
    await chooseOption(trigger(), "分级");
    expect(picked).toEqual(["rating"]);
    expect(trigger().textContent).toContain("分级");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("键盘：↓ 展开并高亮当前值，↑↓ 移动高亮，Enter 选中，Esc 收起不改值", async () => {
    const picked: string[] = [];
    render(<Sort onPick={(v) => picked.push(v)} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const list = await screen.findByRole("listbox");
    const highlighted = () => list.querySelector("[data-highlighted]")?.textContent;
    await act(async () => {});
    expect(highlighted()).toBe("添加时间");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(highlighted()).toBe("尺寸");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(highlighted()).toBe("添加时间");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(highlighted()).toBe("名称");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(picked).toEqual([]);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    await screen.findByRole("listbox");
    await act(async () => {});
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await act(async () => {});
    expect(picked).toEqual(["name"]);
  });

  it("禁用的项可以高亮，但 Enter 不选它", async () => {
    const picked: string[] = [];
    render(<Sort onPick={(v) => picked.push(v)} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    await screen.findByRole("listbox");
    await act(async () => {});
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await act(async () => {});
    expect(picked).toEqual([]);
  });

  it("禁用时不能展开", () => {
    render(<Select label="排序" value="name" options={OPTIONS} disabled onChange={() => {}} />);
    fireEvent.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
