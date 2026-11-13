import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { createRef, useState, type Ref } from "react";
import { DRAG_IMAGE_SOURCES, DRAG_IMAGES, Wall, type WallHandle } from "./Wall";
import { workspaceCard } from "../test/workspacePage";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import { fakeBackend } from "../test/backend";

// 墙上的整摞（#418）：拖到文件夹上带着全部页，移走整摞时顶栏的张数一起减。
const page = (id: string) => workspaceCard({ id, width: 100, height: 120 });
function browse(): WorkspacePage {
  const set = { key: "pixiv:9", pages: ["p0", "p1", "p2"].map(page) };
  const cards = [page("a"), { ...page("p0"), set }, page("b")];
  return { cards, total: cards.length, nextCursor: null, status: { revision: "r", libraries: [] }, images: 5 };
}
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  fakeBackend({ workspace_browse: () => browse() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Harness({ wall, onTotal }: { wall?: Ref<WallHandle>; onTotal?: (count: number | null) => void }) {
  const [selected, setSelected] = useState(new Set<string>());
  return <Wall ref={wall} workspaceScope={{ kind: "all" }} scope={{ kind: "all" }} reloadKey={0} selected={selected} stackSets
    onSelectionChange={setSelected} onOpenImage={() => {}} viewerOpen={false} onTotalChange={onTotal} />;
}
const card = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;

it("拖整摞到文件夹上：带着它的全部页，按页序", async () => {
  render(<Harness />);
  await screen.findAllByRole("option");
  const data = new Map<string, string>();
  fireEvent.dragStart(card("p0"), { dataTransfer: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "" } });
  expect(JSON.parse(data.get(DRAG_IMAGES)!)).toEqual(["p0", "p1", "p2"]);
  expect(JSON.parse(data.get(DRAG_IMAGE_SOURCES)!)).toEqual({ L1: ["p0", "p1", "p2"] });
});

it("先移走整摞时顶栏的张数减去它的全部页，没做成放回时加回来", async () => {
  const wall = createRef<WallHandle>();
  const onTotal = vi.fn();
  render(<Harness wall={wall} onTotal={onTotal} />);
  await screen.findAllByRole("option");
  expect(onTotal).toHaveBeenLastCalledWith(5);
  let putBack: (failed: string[]) => void = () => {};
  act(() => { putBack = wall.current!.remove(["p0", "p1", "p2"]); });
  expect(onTotal).toHaveBeenLastCalledWith(2);
  act(() => putBack(["p0", "p1", "p2"]));
  expect(onTotal).toHaveBeenLastCalledWith(5);
});
