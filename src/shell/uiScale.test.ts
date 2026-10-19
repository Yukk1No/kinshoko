import { expect, it } from "vitest";
import { stepUiScale, UI_SCALE_LEVELS, uiScaleStepForKey } from "./uiScale";

it("界面缩放有八个固定档位，默认 100%", () => {
  expect(UI_SCALE_LEVELS).toEqual([80, 90, 100, 110, 125, 150, 175, 200]);
});

it("Ctrl+= 放大一档、Ctrl+- 缩小一档、Ctrl+0 复位到 100%", () => {
  expect(stepUiScale(100, "in")).toBe(110);
  expect(stepUiScale(110, "in")).toBe(125);
  expect(stepUiScale(125, "out")).toBe(110);
  expect(stepUiScale(175, "reset")).toBe(100);
});

it("到最高、最低档后再按不动作", () => {
  expect(stepUiScale(200, "in")).toBe(200);
  expect(stepUiScale(80, "out")).toBe(80);
});

it("按字符认键：Ctrl+= 与 Ctrl++ 放大，Ctrl+- 缩小，Ctrl+0 复位；不按 Ctrl 或加 Alt 不算", () => {
  const key = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    uiScaleStepForKey({ ctrlKey: true, metaKey: false, altKey: false, key, ...mods });
  expect(key("=")).toBe("in");
  expect(key("+")).toBe("in");
  expect(key("-")).toBe("out");
  expect(key("0")).toBe("reset");
  expect(key("=", { ctrlKey: false })).toBeNull();
  expect(key("=", { altKey: true })).toBeNull();
  expect(key("s")).toBeNull();
});
