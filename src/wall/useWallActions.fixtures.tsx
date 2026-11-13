import { afterEach, beforeEach, vi } from "vitest";
import { fakeBackend, type FakeBackend } from "../test/backend";
import { useWallActions, type WallActionsOptions } from "./useWallActions";
import type { WallMenuActions } from "./WallMenu";
import type { BrowserCard } from "./Wall";

/** useWallActions 测试共用的卡片、调用记录与挂载：每个测试文件调一次 `setupWallActions()`。 */
export const card = (id: string, libraryId = "L1"): BrowserCard => ({
  id, width: 100, height: 100, adult: false, libraryId, imageId: `i${id}`, sources: [],
});
export let backend: FakeBackend;
/** 收到过的调用，按先后；给了命令名就只看那一条命令的。 */
export const calls = (command?: string) => backend.calls(command);
export function setupWallActions() {
  beforeEach(() => {
    // 图片墙动作发出的命令都答 void；用例要别的回答时用 `backend.on` 改。
    backend = fakeBackend({ pin_reference: null, copy_reference_image: null, reveal_reference_image: null, workspace_source_group: null, permanent_delete: null });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
}

export let api: WallMenuActions;
export function Harness(options: Partial<WallActionsOptions>) {
  const { actions, dialogs } = useWallActions({
    safe: false, onOpen: () => {}, onCrop: () => {}, onInspect: () => {}, onChanged: () => {},
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
