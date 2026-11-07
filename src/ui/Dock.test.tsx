import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FolderInput, X } from "lucide-react";
import { Dock } from "./Dock";
import { MenuItem } from "./Menu";

afterEach(() => { cleanup(); document.documentElement.removeAttribute("data-reduced-motion"); });

const trayDock = () => render(<Dock label="查看" onSelect={() => {}} items={[
  { id: "ground", label: "背景", icon: <X size={16} />, trayValue: "grey", tray: [
    { id: "grey", label: "浅灰", icon: <X size={16} /> }, { id: "dark", label: "深色", icon: <X size={16} /> }] },
]} />);
const tray = () => document.querySelector<HTMLElement>(".k-dock-tray");
const tip = () => document.querySelector(".k-dock-tip");

describe("Dock 抽屉进出对称（#455）", () => {
  it("关上时抽屉先缩回按钮再卸载；缩回途中不叠出悬停标签，缩回后才出现", async () => {
    trayDock();
    const button = screen.getByRole("button", { name: "背景" });
    fireEvent.mouseEnter(button.closest(".k-dock-cell")!);
    fireEvent.click(button);
    expect(tray()).toBeTruthy();
    await waitFor(() => expect(tip()).toBeNull());
    fireEvent.click(button);
    expect(tray()).toBeTruthy();
    expect(tip()).toBeNull();
    await waitFor(() => expect(tray()).toBeNull());
    await waitFor(() => expect(tip()?.textContent).toContain("背景"));
  });

  it("减弱动效下直接到终态：打开当场不透明、不偏移，关上马上卸载", async () => {
    document.documentElement.setAttribute("data-reduced-motion", "");
    trayDock();
    const button = screen.getByRole("button", { name: "背景" });
    fireEvent.click(button);
    expect(tray()!.style.opacity).toBe("1");
    expect(tray()!.style.transform).toBe("none");
    fireEvent.click(button);
    await act(async () => { await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); });
    expect(tray()).toBeNull();
  });
});

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
