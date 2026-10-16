import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import { Wall } from "./Wall";

let replies: ((page: WorkspacePage) => void)[];
beforeEach(() => {
  replies = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 961 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 669 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((command) => {
    if (command !== "plugin:library|workspace_browse") throw new Error(command);
    return new Promise<WorkspacePage>((resolve) => replies.push(resolve));
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

it("provider refresh restores the viewed card after real empty-list scroll clamping", async () => {
  const cards = Array.from({ length: 121 }, (_, index) => ({
    id: String(index), width: 100, height: 100, adult: false, thumbnail: "A/" + index + "/256",
    libraryId: "A", imageId: String(index), sources: [],
  }));
  const page: WorkspacePage = { cards, total: cards.length, nextCursor: null, status: { revision: "r", libraries: [] } };
  const props = { libraryId: "A", scope: { kind: "all" as const }, workspaceScope: { kind: "all" as const },
    safeMode: true, selected: new Set<string>(), onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false };
  const view = render(<Wall {...props} reloadKey={0} />);
  await act(async () => replies[0](page));
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = 2000;
  fireEvent.scroll(wall);
  const visibleBefore = [...wall.querySelectorAll<HTMLElement>(".card")].find(card => {
    const top = parseFloat(card.style.top);
    return top >= wall.scrollTop && top < wall.scrollTop + wall.clientHeight;
  })!;
  const originalId = visibleBefore.dataset.id;
  const originalOffset = parseFloat(visibleBefore.style.top) - wall.scrollTop;

  view.rerender(<Wall {...props} reloadKey={1} />);
  expect(wall.querySelector(".card")).toBeNull();
  // Native run1791494531975 observes this browser event when the canvas collapses.
  // jsdom has no layout/scroll clamping, so deliver the actual observed DOM scroll explicitly.
  wall.scrollTop = 0;
  fireEvent.scroll(wall);
  await act(async () => replies.at(-1)!(page));
  expect(wall.scrollTop).toBe(2000);
  const restored = wall.querySelector<HTMLElement>('[data-id="' + originalId + '"]')!;
  expect(parseFloat(restored.style.top) - wall.scrollTop).toBeCloseTo(originalOffset);
});
