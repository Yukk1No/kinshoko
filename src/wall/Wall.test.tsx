import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { Wall } from "./Wall";
import { resize } from "../test/platform";
import { workspacePage } from "../test/workspacePage";
import { fakeBackend } from "../test/backend";

let width: number;
beforeEach(() => {
  width = 1121;
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  fakeBackend({ workspace_browse: () => workspacePage(Array.from({ length: 300 }, (_, i) => ({ id: String(i), width: 100, height: 100 }))) });
});
afterEach(() => { vi.unstubAllGlobals(); });

it("1121 → 1369 → 1121 连续重排后同一张图保持偏移，多次自身滚动事件不漂移", async () => {
  render(<Wall workspaceScope={{ kind: "all" }} scope={{ kind: "all" }} reloadKey={0} selected={new Set()}
    onSelectionChange={() => {}} onOpenImage={() => {}} viewerOpen={false} />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = 2000;
  fireEvent.scroll(wall);
  const card = () => document.querySelector<HTMLElement>('[data-id="28"]')!;
  const offset = () => parseFloat(card().style.top) - wall.scrollTop;
  expect(offset()).toBeCloseTo(-54.25);

  width = 1369;
  act(() => resize(wall));
  expect(offset()).toBeCloseTo(-54.25);
  fireEvent.scroll(wall);
  fireEvent.scroll(wall);
  width = 1121;
  act(() => resize(wall));
  expect(offset()).toBeCloseTo(-54.25);
});
