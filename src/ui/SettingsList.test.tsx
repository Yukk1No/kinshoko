import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsGroup, SettingsRow } from "./SettingsList";
import settings from "./settings.css?raw";

afterEach(cleanup);

// 补充说明不只在鼠标悬停时可见：读屏软件经 aria-describedby 读到，键盘聚焦到控件时显示在名称下方。
it("行的补充说明挂到这一行的控件上", () => {
  render(<ul><SettingsRow title="安全范围" hint="开启后遮住标为敏感和成人的图"><button type="button">开</button></SettingsRow></ul>);
  const control = screen.getByRole("button", { name: "开" });
  const ids = control.getAttribute("aria-describedby")!.split(" ");
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain("开启后遮住标为敏感和成人的图");
});

it("行下方的控件（例如备份的文件输入与按钮）同样读到补充说明", () => {
  render(<ul><SettingsRow title="偏好备份" hint="只备份本设备的偏好，不含图库" below={<button type="button">导出</button>} /></ul>);
  const ids = screen.getByRole("button", { name: "导出" }).getAttribute("aria-describedby")!.split(" ");
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain("只备份本设备的偏好，不含图库");
});

it("键盘聚焦到这一行的控件时显示补充说明", () => {
  expect(settings).toMatch(/\.k-set-row:has\(:focus-visible\) \.k-set-hint \{ display: block; \}/);
});

// #310：组名不再显示（会和页面标题重复、对不齐），只作无障碍名称；整组的说明放进组的容器里。
it("一组设置不显示组名，说明和行在同一个容器里", () => {
  const { container } = render(<SettingsGroup label="图库" note="恢复不改当前设置。"><SettingsRow title="备份位置" /></SettingsGroup>);
  expect(container.querySelector("h4")).toBeNull();
  const list = screen.getByRole("list", { name: "图库" });
  const group = list.parentElement!;
  expect(group.classList.contains("k-set-group")).toBe(true);
  expect(group.querySelector(".k-set-note")?.textContent).toBe("恢复不改当前设置。");
});
