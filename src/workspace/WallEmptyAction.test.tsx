import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WallEmptyAction } from "./WallEmptyAction";
import type { ImportControl } from "../library/ImportMenu";

afterEach(cleanup);

const control = () => ({
  current: { files: vi.fn(), folder: vi.fn(), eagle: vi.fn(), clipboard: vi.fn() } satisfies ImportControl,
});

it("空图库直接给导入入口：图片是主要操作，文件夹次之", () => {
  const importControl = control();
  render(
    <WallEmptyAction
      searching={false}
      scope={{ kind: "all" }}
      importControl={importControl}
      onClearConditions={vi.fn()}
    />,
  );
  const files = screen.getByRole("button", { name: "导入图片" });
  expect(files.className).toContain("is-primary");
  fireEvent.click(files);
  fireEvent.click(screen.getByRole("button", { name: "导入文件夹" }));
  expect(importControl.current.files).toHaveBeenCalledTimes(1);
  expect(importControl.current.folder).toHaveBeenCalledTimes(1);
});

it("查找没有结果时给“清除条件”", () => {
  const onClear = vi.fn();
  render(<WallEmptyAction searching scope={{ kind: "all" }} importControl={control()} onClearConditions={onClear} />);
  fireEvent.click(screen.getByRole("button", { name: "清除条件" }));
  expect(onClear).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "导入图片" })).toBeNull();
});

it("文件夹、未归类与回收站的空状态只有那句话", () => {
  for (const scope of [{ kind: "folder", id: "f" }, { kind: "unassigned" }, { kind: "trash" }] as const) {
    const { container } = render(
      <WallEmptyAction searching={false} scope={scope} importControl={control()} onClearConditions={vi.fn()} />,
    );
    expect(container.querySelector("button")).toBeNull();
    cleanup();
  }
});
