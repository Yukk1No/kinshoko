import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import { backend, expandLibrary, library, sent } from "./App.fixtures";

afterEach(() => vi.unstubAllGlobals());

it("external files dropped on a sidebar folder use that folder without navigating or remembering it", async () => {
  backend(library);
  vi.stubGlobal("__KINSHOKO_FILE_DROP__", vi.fn());
  render(<App />);
  await screen.findAllByRole("img");
  await expandLibrary();
  const folder = await screen.findByRole("button", { name: /人物.*1/ });
  fireEvent.dragEnter(folder, { dataTransfer: { types: ["Files"] } });
  fireEvent.drop(folder.querySelector(".sidebar-count")!, {
    dataTransfer: { types: ["Files"], files: [new File(["image"], "image.png")] },
  });
  await act(() => emit("kinshoko-file-drop", ["D:\\image.png"]));
  const dialog = await screen.findByRole("dialog", { name: "导入图片" });
  expect(within(dialog).getByRole("combobox", { name: "文件夹" }).textContent).toContain("人物");
  const start = within(dialog).getByRole("button", { name: "开始导入" });
  await waitFor(() => expect(start).toHaveProperty("disabled", false));
  fireEvent.click(start);
  await waitFor(() =>
    expect(sent("start_import")).toEqual([
      expect.objectContaining({
        libraryId: "L1",
        source: { paths: ["D:\\image.png"] },
        destination: { libraryId: "L1", folderId: "F1" },
      }),
    ]),
  );
  expect(sent("remember_import_destination")).toEqual([]);
  expect(folder.getAttribute("aria-current")).toBeNull();
});
