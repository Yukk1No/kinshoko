import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { library, clean, backend, sent, confirmImport } from "./App.fixtures";
import type { Args } from "./test/backend";

describe("上次导入中断", () => {
  it("上次导入中断时提示撤回了哪些文件，并可以重新导入", async () => {
    backend(library, {
      interrupted: ["D:\\参考\\b.png"],
      orphans: ["originals/ab/x.png"],
      discardedStaging: 0,
    });
    render(<App />);

    // 轻提示（#388）：撤回与不认识的文件各报数量，“重新导入”把撤回的文件再导一次。
    expect(await screen.findByText("上次导入中断")).toBeTruthy();
    expect(screen.getByText(/已撤销 1 个文件/).textContent).toContain("1 个无法识别的文件");
    fireEvent.click(screen.getByRole("button", { name: "重新导入" }));
    await confirmImport();

    await waitFor(() =>
      expect(sent("start_import")).toEqual([
        {
          libraryId: "L1",
          source: { paths: ["D:\\参考\\b.png"] },
          options: { eagleDeletedContent: "skipDeleted" },
          destination: { libraryId: "L1", folderId: null },
        },
      ]),
    );
  });

  it("启动时没选过保存位置也读得到上次中断：只按登记的资料库问后端", async () => {
    const asked: unknown[] = [];
    backend(library, clean, {
      recovery: (args: Args) => {
        const { libraryId } = args as { libraryId: string };
        asked.push(libraryId);
        // 与真实后端一致：不是登记的资料库就拒绝。
        if (libraryId !== "L1") throw new Error("unknownLibrary");
        return { interrupted: ["D:\\参考\\b.png"], orphans: [], discardedStaging: 0 };
      },
    });
    render(<App />);

    expect(await screen.findByText("上次导入中断")).toBeTruthy();
    expect(asked).toEqual(["L1"]);
  });

  it("每个资料库各读一次上次中断，重新导入回到那个资料库，读不到的库不挡别的库", async () => {
    const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
    const asked: string[] = [];
    backend(library, clean, {
      registered_libraries: () => [
        { library, unavailable: null },
        { library: other, unavailable: null },
      ],
      recovery: (args: Args) => {
        const { libraryId } = args as { libraryId: string };
        asked.push(libraryId);
        if (libraryId === "L1") throw new Error("busy");
        return { interrupted: ["E:\\图\\半张.png"], orphans: [], discardedStaging: 0 };
      },
    });
    render(<App />);

    expect(await screen.findByText(/私人收藏：已撤销 1 个文件/)).toBeTruthy();
    expect(asked).toEqual(["L1", "L2"]);
    fireEvent.click(screen.getByRole("button", { name: "重新导入" }));
    await confirmImport();

    await waitFor(() =>
      expect(sent("start_import")).toEqual([
        {
          libraryId: "L2",
          source: { paths: ["E:\\图\\半张.png"] },
          options: { eagleDeletedContent: "skipDeleted" },
          destination: { libraryId: "L2", folderId: null },
        },
      ]),
    );
  });
});
