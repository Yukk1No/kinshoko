import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsRow } from "./SettingsList";
import settings from "./settings.css?raw";

afterEach(cleanup);

// 补充说明不只在鼠标悬停时可见：读屏软件经 aria-describedby 读到，键盘聚焦到控件时显示在名称下方。
it("行的补充说明挂到这一行的控件上", () => {
  render(<ul><SettingsRow title="安全范围" hint="开启后遮住标为敏感和成人的图"><button type="button">开</button></SettingsRow></ul>);
  const control = screen.getByRole("button", { name: "开" });
  const ids = control.getAttribute("aria-describedby")!.split(" ");
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain("开启后遮住标为敏感和成人的图");
});

it("键盘聚焦到这一行的控件时显示补充说明", () => {
  expect(settings).toMatch(/\.k-set-row:has\(:focus-visible\) \.k-set-hint \{ display: block; \}/);
});
