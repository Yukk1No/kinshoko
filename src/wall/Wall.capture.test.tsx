import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { Wall } from "./Wall";

const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { events.set(name, callback); return () => events.delete(name); }) }));
afterEach(() => { cleanup(); clearMocks(); events.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("F1 requests the current loaded visible source after immediate scroll, rather than the last reported card", async () => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.matches("img") ? new DOMRect(100, 120, 240, 160) : new DOMRect(0, 60, 1000, 740);
  });
  const reports: any[] = [];
  mockConvertFileSrc("windows");
  mockIPC((command, args) => {
    if (command === "plugin:library|browse") return { cards: [{ id: "original", width: 2400, height: 1600, adult: false, thumbnail: "read-only/original/256" }], total: 1, nextCursor: null };
    if (command === "plugin:desktop|report_capture_references") reports.push(args);
  });
  render(<Wall libraryId="read-only" scope={{ kind: "all" }} reloadKey={0} selected={new Set()} onSelectionChange={() => {}} onOpenImage={() => {}} viewerOpen={false} />);
  const img = await screen.findByRole("img");
  Object.defineProperties(img, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 240 }, naturalHeight: { configurable: true, value: 160 } });
  fireEvent.load(img);
  await waitFor(() => expect(events.has("capture-reference-request")).toBe(true));
  await act(async () => events.get("capture-reference-request")!({ payload: { request: "first" } }));
  await waitFor(() => expect(reports).toHaveLength(1));
  expect(reports[0]).toMatchObject({ request: "first", frame: { references: [{ libraryId: "read-only", imageId: "original", shown: { x: 150, y: 180, width: 360, height: 240 }, visible: { x: 150, y: 180, width: 360, height: 240 }, covered: [] }] } });
  const firstGeneration = reports[0].frame.generation;
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = 1; fireEvent.scroll(wall);
  wall.scrollTop = 0; fireEvent.scroll(wall);
  await act(async () => events.get("capture-reference-request")!({ payload: { request: "second" } }));
  await waitFor(() => expect(reports).toHaveLength(2));
  expect(reports[1].frame.generation).toBeGreaterThan(firstGeneration);
  expect(reports[1].frame.references).toEqual(reports[0].frame.references);
  await act(async () => {
    const older = events.get("capture-reference-request")!({ payload: { request: "cancelled-old-request" } });
    const latest = events.get("capture-reference-request")!({ payload: { request: "current-request" } });
    await Promise.all([older, latest]);
  });
  await waitFor(() => expect(reports).toHaveLength(3));
  expect(reports[2].request).toBe("current-request");
});
