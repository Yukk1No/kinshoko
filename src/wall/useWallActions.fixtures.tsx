import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useWallActions, type WallActionsOptions } from "./useWallActions";
import type { WallMenuActions } from "./WallMenu";
import type { BrowserCard } from "./Wall";

/** useWallActions 测试共用的卡片、调用记录与挂载：每个测试文件调一次 `setupWallActions()`。 */
export const card = (id: string, libraryId = "L1"): BrowserCard => ({
  id, width: 100, height: 100, thumbnail: "", adult: false, libraryId, imageId: `i${id}`, sources: [],
});
export let calls: { cmd: string; args: Record<string, unknown> }[];
export function setupWallActions() {
  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => { calls.push({ cmd, args: args as Record<string, unknown> }); return null; });
  });
  afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });
}

export let api: WallMenuActions;
export function Harness(options: Partial<WallActionsOptions>) {
  const { actions, dialogs } = useWallActions({
    safe: false, activeLibraryId: "L1", onOpen: () => {}, onCrop: () => {}, onInspect: () => {}, onChanged: () => {},
    onClearSelection: () => {}, onError: () => {}, importFrom: () => {}, selectAll: () => {}, setDensity: () => {},
    onNotice: () => {}, importClipboard: async () => {}, ...options,
  });
  api = actions;
  return <>{dialogs}</>;
}
export const named = (id: string, libraryId: string, libraryName: string): BrowserCard => ({
  ...card(id, libraryId),
  sources: [{ libraryId, libraryName, imageId: `i${id}`, unavailable: null, matches: true, deleted: true }],
} as BrowserCard);
