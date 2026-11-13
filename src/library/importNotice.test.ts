import { expect, it, vi } from "vitest";
import type { ImportReport } from "../bindings/ImportReport";
import type { ImportItem } from "../bindings/ImportItem";
import { importNotice } from "./ImportBarParts";

const report = (items: ImportItem[], cancelled = false): ImportReport => ({
  sealedDuplicates: false,
  privateSummary: false,
  trashDuplicates: false,
  items,
  cancelled,
  fromEagle: false,
  eagleMissing: 0,
  eagleRelocations: [],
});
const imported = (n: number): ImportItem[] =>
  Array.from({ length: n }, (_, i) => ({ path: `a${i}.png`, outcome: { kind: "imported", imageId: `i${i}` } }));

it("顺利导入时提示带“打开”，去导入的位置看结果", () => {
  const show = vi.fn();
  const toast = importNotice(report(imported(3)), "图库 / 未归类").toast(vi.fn(), show);
  expect(toast.action?.label).toBe("打开");
  toast.action?.onClick();
  expect(show).toHaveBeenCalledTimes(1);
});

it("有要处理的项时仍是“查看”，打开回执", () => {
  const view = vi.fn();
  const items: ImportItem[] = [
    ...imported(1),
    { path: "bad.png", outcome: { kind: "readFailed", reason: { code: "system", detail: "x" } } },
  ];
  const toast = importNotice(report(items), null).toast(view, vi.fn());
  expect(toast.action?.label).toBe("查看");
});

it("取消、或者一张也没进来时不带“打开”", () => {
  expect(importNotice(report(imported(2), true), null).toast(vi.fn(), vi.fn()).action).toBeUndefined();
  expect(importNotice(report([]), null).toast(vi.fn(), vi.fn()).action).toBeUndefined();
});
