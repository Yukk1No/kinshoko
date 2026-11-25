import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ContentRating } from "./bindings/ContentRating";
import type { SafeModeScope } from "./bindings/SafeModeScope";
import { App } from "./App";
import { library, clean, detail, backend, sent, selectionPanel } from "./App.fixtures";
import { cardOf } from "./App.safe-mode.fixtures";
import type { Args } from "./test/backend";

describe("安全模式", () => {
  describe("详情面板修改分级按安全模式范围取消选择（#711）", () => {
    const setupWithScope = (safeModeScope: SafeModeScope) => {
      let currentRating: ContentRating = "general";
      backend(library, clean, {
        shell_settings: () => ({
          autostart: true,
          shortcuts: [],
          showApproxSource: false,
          keepSelectionOnSafeMode: false,
          inspectorOpen: true,
          safeModeScope,
        }),
        image: (args: Args) => {
          const base = detail(args.imageId as string, null);
          return {
            ...base,
            rating: { imageId: base.id, suggested: "general", manual: currentRating, effective: currentRating },
          };
        },
        edit: (args: Args) => {
          const edits = args.edits as { kind: string; rating?: ContentRating }[];
          const next = edits.find((e) => e.kind === "setRating")?.rating;
          if (next) currentRating = next;
          return (args.ids as string[]).map((id) => ({
            ...detail(id, null),
            rating: { imageId: id, suggested: "general", manual: currentRating, effective: currentRating },
          }));
        },
      });
    };

    it("范围设为轻度及以上时，详情面板把选中图改为轻度即取消选择", async () => {
      setupWithScope("sensitive");
      render(<App />);
      await waitFor(() => expect(cardOf("a")).toBeTruthy());
      await waitFor(() => expect(sent("shell_settings").length).toBeGreaterThan(0));
      fireEvent.keyDown(cardOf("a")!, { key: " " });

      const rating = await screen.findByRole("group", { name: "内容分级" });
      fireEvent.click(within(rating).getByRole("button", { name: "轻度" }));

      await waitFor(() => expect(selectionPanel()).toBeNull());
    });

    it("范围设为仅成人时，详情面板把选中图改为敏感仍保持选中", async () => {
      setupWithScope("explicit");
      render(<App />);
      await waitFor(() => expect(cardOf("a")).toBeTruthy());
      await waitFor(() => expect(sent("shell_settings").length).toBeGreaterThan(0));
      fireEvent.keyDown(cardOf("a")!, { key: " " });

      const rating = await screen.findByRole("group", { name: "内容分级" });
      fireEvent.click(within(rating).getByRole("button", { name: "敏感" }));

      await waitFor(() =>
        expect(within(rating).getByRole("button", { name: "敏感" }).getAttribute("aria-pressed")).toBe("true"),
      );
      expect(selectionPanel()).toBeTruthy();
    });
  });
});
