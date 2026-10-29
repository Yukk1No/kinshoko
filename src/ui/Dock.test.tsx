import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FolderInput, X } from "lucide-react";
import { Dock } from "./Dock";
import { MenuItem } from "./Menu";

afterEach(cleanup);

describe("Dock 里点开菜单的项（#180）", () => {
  it("点开后向上弹出菜单，选中菜单项；其他项照常调用 onSelect", async () => {
    const put = vi.fn();
    const onSelect = vi.fn();
    render(<Dock label="批量" onSelect={onSelect} items={[
      { id: "put", label: "放入文件夹", icon: <FolderInput size={16} />, menu: <MenuItem onClick={() => put("F1")}>人物</MenuItem> },
      { id: "clear", label: "取消选择", icon: <X size={16} /> },
    ]} />);
    const trigger = screen.getByRole("button", { name: "放入文件夹" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "人物" }));
    expect(put).toHaveBeenCalledWith("F1");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
    expect(onSelect).toHaveBeenCalledWith("clear");
  });

  it("禁用时点不开，悬停标签带上原因", () => {
    render(<Dock label="批量" onSelect={() => {}} items={[
      { id: "put", label: "放入文件夹", note: "还没有文件夹", disabled: true, icon: <FolderInput size={16} />, menu: <MenuItem>人物</MenuItem> },
    ]} />);
    const trigger = screen.getByRole("button", { name: "放入文件夹" });
    expect(trigger).toHaveProperty("disabled", true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.mouseEnter(trigger.closest(".k-dock-cell")!);
    expect(document.querySelector(".k-dock-tip")?.textContent).toContain("还没有文件夹");
  });
});
