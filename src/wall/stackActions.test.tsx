import { expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { MenuPopup } from "../ui/Menu";
import { WallMenu, type WallMenuActions } from "./WallMenu";
import type { BrowserCard } from "./Wall";
import { api, backend, calls, card, Harness, setupWallActions } from "./useWallActions.fixtures";

// 选中整摞（#418）：删除、整理、移文件夹作用于全部页，写明张数；钉住与加入参考组只取封面。
setupWallActions();

const EDIT_SOURCES = "workspace_edit_sources";
type Target = { libraryId: string; imageId: string; contentId: string };
const stack = (key: string, ids: string[], libraryId = "L1") =>
  ({ ...card(ids[0], libraryId), set: { key, pages: ids.map((id) => card(id, libraryId)) } }) as BrowserCard;

it("整摞移到回收站作用于它的全部页，提示写明张数，撤销还原同样这些页", async () => {
  backend.on(EDIT_SOURCES, []);
  const removeCards = vi.fn((_cards: BrowserCard[]) => () => {});
  render(<Harness removeCards={removeCards} />);
  act(() => api.edit([stack("pixiv:1", ["a0", "a1", "a2"]), card("b")], [{ kind: "delete" }], true));
  expect(await screen.findByText("已移到回收站")).toBeTruthy();
  expect(screen.getByText("4 张")).toBeTruthy();
  const targets = calls(EDIT_SOURCES)[0]!.args.targets as Target[];
  expect(targets.map((t) => t.contentId)).toEqual(["a0", "a1", "a2", "b"]);
  expect(removeCards.mock.calls[0]![0].map((c) => c.id)).toEqual(["a0", "a1", "a2", "b"]);
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(calls(EDIT_SOURCES)).toHaveLength(2));
  expect((calls(EDIT_SOURCES)[1]!.args.targets as Target[]).map((t) => t.contentId)).toEqual(["a0", "a1", "a2", "b"]);
});

it("整摞移到文件夹与改分级作用于全部页；托盘里的单页只作用于这一页", async () => {
  backend.on(EDIT_SOURCES, []);
  render(<Harness />);
  act(() => api.edit([stack("pixiv:1", ["a0", "a1"])], [{ kind: "addToFolder", folderId: "f1" }], false));
  await waitFor(() => expect(calls(EDIT_SOURCES)).toHaveLength(1));
  expect((calls(EDIT_SOURCES)[0]!.args.targets as Target[]).map((t) => t.contentId)).toEqual(["a0", "a1"]);
  act(() => api.edit([card("a1")], [{ kind: "setRating", rating: "general" }], false));
  await waitFor(() => expect(calls(EDIT_SOURCES)).toHaveLength(2));
  expect((calls(EDIT_SOURCES)[1]!.args.targets as Target[]).map((t) => t.contentId)).toEqual(["a1"]);
});

it("钉住与加入参考组只取封面", async () => {
  render(<Harness />);
  act(() => api.pin([stack("pixiv:1", ["a0", "a1", "a2"])], { x: 0, y: 0 }));
  await waitFor(() => expect(calls("pin_reference")).toHaveLength(1));
  expect(calls("pin_reference")[0]!.args.imageId).toBe("ia0");
  act(() => api.addToGroup([stack("pixiv:1", ["a0", "a1", "a2"])], "g1"));
  await waitFor(() => expect(calls("workspace_source_group")).toHaveLength(1));
});

it("整摞永久删除时确认框写明一共几张", async () => {
  backend.on("preview_permanent_delete_batch", [
    { libraryId: "L1", preview: { imageIds: ["ia0", "ia1", "ia2"], groups: [], token: "t" }, error: null },
  ]);
  render(<Harness />);
  act(() => api.purge([stack("pixiv:1", ["a0", "a1", "a2"])]));
  expect(await screen.findByText("永久删除这 3 张图？原图与整理结果都会删除，无法恢复。")).toBeTruthy();
  expect(calls("preview_permanent_delete_batch")[0]!.args).toEqual({
    targets: [
      { libraryId: "L1", imageId: "ia0" },
      { libraryId: "L1", imageId: "ia1" },
      { libraryId: "L1", imageId: "ia2" },
    ],
  });
});

function menuActions(): WallMenuActions {
  return {
    open: vi.fn(),
    pin: vi.fn(),
    crop: vi.fn(),
    edit: vi.fn(),
    addToGroup: vi.fn(),
    inspectSources: vi.fn(),
    purge: vi.fn(),
    importFrom: vi.fn(),
    selectAll: vi.fn(),
    setDensity: vi.fn(),
    copy: vi.fn(),
    reveal: vi.fn(),
    importClipboard: vi.fn(),
    clipboardHasImage: vi.fn(async () => true),
    folders: vi.fn(async () => []),
    inFolder: vi.fn(async () => false),
    groups: vi.fn(async () => []),
  };
}
function menuRows(cards: BrowserCard[]) {
  render(
    <ContextMenu.Root open>
      <MenuPopup label="图片墙菜单">
        <WallMenu
          target={{ kind: "cards", cards, point: { x: 0, y: 0 } }}
          scope={{ kind: "all" }}
          density={240}
          actions={menuActions()}
        />
      </MenuPopup>
    </ContextMenu.Root>,
  );
  return within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((row) => row.textContent);
}

it("右键整摞：移到回收站写明这一摞的张数；多选时算上每一摞的全部页，钉住只算封面", () => {
  expect(menuRows([stack("pixiv:1", ["a0", "a1", "a2"])])).toContain("移到回收站（3 张）Del");
  cleanup();
  const rows = menuRows([stack("pixiv:1", ["a0", "a1", "a2"]), card("b")]);
  expect(rows).toContain("钉住 2 张P");
  expect(rows).toContain("移到回收站（4 张）Del");
});
