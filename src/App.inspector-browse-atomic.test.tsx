// 原子交付一页时，查看器关闭与选择收回都按这一页的卡片决定（#742）。
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { doubleClick } from "./App.fixtures";
import type { WorkspaceCard } from "./bindings/WorkspaceCard";
import { card, libraries, source, start, tile, viewed, viewer } from "./App.inspector.fixtures";

it("新修订的原子交付换掉叠放封面时，关查看器的同一帧按新卡片把选择收回到新封面", async () => {
  const page = (id: string) => card(id, source("L1", `i-${id}`));
  const stack = (pages: WorkspaceCard[]) => ({ ...pages[0], set: { key: "pixiv:1", pages } }) as WorkspaceCard;
  let current = {
    status: { revision: "r1", libraries },
    cards: [card("a1", source("L1", "i1")), stack([page("a0"), page("s1")])],
  };
  await start({
    workspace_status: () => current.status,
    workspace_browse: () => ({
      cards: current.cards,
      total: current.cards.length,
      images: 3,
      nextCursor: null,
      status: current.status,
    }),
  });
  doubleClick(tile("a1"));
  await viewed("L1/i1");
  fireEvent.keyDown(viewer(), { key: "ArrowRight" });
  await viewed("L1/i-a0");
  fireEvent.keyDown(viewer(), { key: "ArrowRight" });
  await viewed("L1/i-s1");

  current = {
    status: { revision: "r2", libraries },
    cards: [card("a1", source("L1", "i1")), stack([page("b0"), page("s1")])],
  };
  await act(() => emit("library-event", { kind: "listStale", libraryId: "L1" }));
  await waitFor(() => expect(tile("b0")).toBeTruthy());
  expect(screen.queryByRole("region", { name: "原图查看器" })).toBeNull();
  expect(tile("b0").getAttribute("aria-selected")).toBe("true");
});
