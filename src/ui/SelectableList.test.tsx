import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SelectableList, type SelectableItem } from "./SelectableList";

const items: SelectableItem[] = [
  { id: "1", name: "Already", done: true },
  { id: "2", name: "Akira", searchText: "222" },
  { id: "3", name: "Mori", searchText: "333" },
];
function Harness({
  values = items,
  changed = () => {},
}: {
  values?: SelectableItem[];
  changed?: (value: ReadonlySet<string>) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <SelectableList
      items={values}
      selected={selected}
      onChange={(next) => {
        changed(next);
        setSelected(next);
      }}
      label="Artists"
      filterLabel="Filter artists"
    />
  );
}

it("筛选姓名与 ID，“全选这 N 个”只增加匹配的未订阅项，清空包括筛选外的选择", () => {
  const changed = vi.fn();
  const { container } = render(<Harness changed={changed} />);
  const filter = screen.getByRole("textbox");
  fireEvent.click(screen.getByRole("checkbox", { name: "Mori" }));
  const scroll = container.querySelector<HTMLElement>(".k-choice-scroll")!;
  scroll.scrollTop = 100;
  fireEvent.change(filter, { target: { value: "aKi" } });
  expect(scroll.scrollTop).toBe(0);
  expect(screen.queryByRole("checkbox", { name: "Mori" })).toBeNull();
  expect(screen.queryByRole("button", { name: "全选未订阅的" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "全选这 1 个" }));
  expect([...changed.mock.lastCall![0]]).toEqual(["3", "2"]);
  fireEvent.change(filter, { target: { value: "333" } });
  expect((screen.getByRole("checkbox", { name: "Mori" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "清空" }));
  expect([...changed.mock.lastCall![0]]).toEqual([]);
});

it("已订阅默认折叠，展开后在可选项之后，DOM 顺序相同且禁用勾选", () => {
  const { container } = render(<Harness />);
  expect(screen.queryByRole("checkbox", { name: "Already" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "显示已订阅的（1）" }));
  expect(screen.getByText("已订阅（1）")).toBeTruthy();
  const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual(["Akira", "Mori", "Already"]);
  expect(boxes[2].disabled && boxes[2].checked).toBe(true);
  expect([...container.querySelectorAll(".k-choice-row")].map((row) => row.textContent)).toEqual([
    "Akira",
    "Mori",
    "Already",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "隐藏已订阅的（1）" }));
  expect(screen.queryByRole("checkbox", { name: "Already" })).toBeNull();
});

it("400 行全选和清空各只提交一次更新", () => {
  const changed = vi.fn();
  const values = Array.from({ length: 400 }, (_, index) => ({
    id: String(index),
    name: `Artist ${index}`,
    done: index === 0,
  }));
  render(<Harness values={values} changed={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "全选未订阅的" }));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].size).toBe(399);
  expect(changed.mock.calls[0][0].has("0")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "清空" }));
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed.mock.calls[1][0].size).toBe(0);
});

it("短名单隐藏筛选与批量动作，条件变化不把焦点按钮复用成另一动作", () => {
  const props = {
    items,
    selected: new Set<string>(["2"]),
    onChange: vi.fn(),
    label: "Artists",
    filterLabel: "Filter artists",
  };
  const { rerender, container } = render(<SelectableList {...props} />);
  const bulk = screen.getByRole("button", { name: "全选未订阅的" });
  bulk.focus();
  rerender(<SelectableList {...props} controls={false} />);
  const toggle = screen.getByRole("button", { name: "显示已订阅的（1）" });
  expect(toggle).not.toBe(bulk);
  expect(document.activeElement).not.toBe(toggle);
  expect(screen.queryByRole("textbox")).toBeNull();
  toggle.focus();
  rerender(<SelectableList {...props} />);
  expect(screen.getByRole("button", { name: "显示已订阅的（1）" })).toBe(toggle);
  expect(document.activeElement).toBe(toggle);
  const controls = [...container.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].filter(
    (element) => !element.disabled,
  );
  expect(controls.slice(0, 5).map((element) => element.getAttribute("aria-label") ?? element.textContent)).toEqual([
    "Filter artists",
    "全选未订阅的",
    "清空",
    "显示已订阅的（1）",
    "Akira",
  ]);
  rerender(<SelectableList {...props} items={items.filter((item) => !item.done)} />);
  expect(toggle.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "清空" }));
});

it("空结果与失败状态不会渲染可选择的行，尾部控件不是复选框 label 的一部分", () => {
  const { rerender } = render(<Harness />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "missing" } });
  expect(screen.getByText("没有匹配的项目")).toBeTruthy();
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  const props = {
    items: [{ id: "1", name: "Rank", trailing: <button type="button">Top</button> }],
    selected: new Set<string>(),
    onChange: vi.fn(),
    label: "Ranks",
    filterLabel: "Filter",
  };
  rerender(<SelectableList {...props} status={<p role="alert">Failed</p>} />);
  expect(screen.getByRole("alert").textContent).toBe("Failed");
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  rerender(<SelectableList {...props} />);
  const box = screen.getByRole("checkbox", { name: "Rank" });
  expect(within(box.closest("label")!).queryByRole("button")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Top" }));
  expect(props.onChange).not.toHaveBeenCalled();
});

it("筛选时已订阅的匹配项直接列出，只在筛选时写出筛出几个", () => {
  render(<Harness />);
  expect(screen.queryByText(/筛出/)).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "alr" } });
  const already = screen.getByRole("checkbox", { name: "Already" }) as HTMLInputElement;
  expect(already.disabled && already.checked).toBe(true);
  expect(screen.queryByText("没有匹配的项目")).toBeNull();
  expect(screen.getByText("筛出 1 个，1 个已订阅")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "显示已订阅的（1）" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  expect(screen.queryByRole("checkbox", { name: "Already" })).toBeNull();
});
