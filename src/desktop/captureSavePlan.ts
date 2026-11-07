import { destinationAvailable } from "../library/SaveDestination";
import type { CaptureChoice } from "../bindings/CaptureChoice";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import type { SaveDestination } from "../bindings/SaveDestination";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";

/**
 * 存参考组前一张截图的去处（#320）：还没选、不加入参考组、只存在参考组里（#270），
 * 或收藏到明确的保存目标后入组。
 */
export type CaptureDestination =
  | { kind: "unselected" }
  | { kind: "skip" }
  | { kind: "keepInGroup" }
  | { kind: "collect"; destination: SaveDestination };

/** 存参考组前桌面上的截图和每张选的去处。 */
export type CaptureSaveDraft<T> = { target: T; entries: CaptureEntry[]; destinations: Record<string, CaptureDestination> };

/** 一张截图还不能保存的原因：没选去处，或选的保存目标现在用不了。 */
export type CaptureProblem = { captureId: string; reason: "unselected" | "unavailable" };

declare const valid: unique symbol;
/** 每张截图都有可用去处的保存计划，只由 {@link prepareSave} 生成。 */
export type CaptureSavePlan<T> = { readonly target: T; readonly choices: CaptureChoice[]; readonly [valid]: true };

export type PreparedSave<T> = { ok: true; plan: CaptureSavePlan<T> } | { ok: false; problems: CaptureProblem[] };

/** 新草稿：只收藏进一个图库、且那个图库连着的截图预选收藏回那里，其余等画师选。 */
export function draftCaptureSave<T>(target: T, entries: CaptureEntry[], libraries: LibraryRegistration[]): CaptureSaveDraft<T> {
  const destinations: Record<string, CaptureDestination> = {};
  for (const entry of entries) {
    const collected = entry.collected.length === 1 ? entry.collected[0] : null;
    destinations[entry.id] = collected && libraries.some((l) => l.library.id === collected.libraryId && !l.unavailable)
      ? { kind: "collect", destination: { libraryId: collected.libraryId, folderId: null } }
      : { kind: "unselected" };
  }
  return { target, entries, destinations };
}

export function destinationOf<T>(draft: CaptureSaveDraft<T>, captureId: string): CaptureDestination {
  return draft.destinations[captureId] ?? { kind: "unselected" };
}

/** 换一张截图的去处；换了图库时文件夹回到未归类，不沿用另一个库的文件夹。 */
export function chooseDestination<T>(draft: CaptureSaveDraft<T>, captureId: string, next: CaptureDestination): CaptureSaveDraft<T> {
  const previous = destinationOf(draft, captureId);
  const chosen = next.kind === "collect" && (previous.kind !== "collect" || previous.destination.libraryId !== next.destination.libraryId)
    ? { kind: "collect" as const, destination: { libraryId: next.destination.libraryId, folderId: null } }
    : next;
  return { ...draft, destinations: { ...draft.destinations, [captureId]: chosen } };
}

/** 核对草稿：每张都有去处且收藏目标现在可用时给出计划，否则逐张写出问题。 */
export function prepareSave<T>(draft: CaptureSaveDraft<T>, providers: WorkspaceDirectory[]): PreparedSave<T> {
  const problems: CaptureProblem[] = [];
  const choices: CaptureChoice[] = [];
  for (const entry of draft.entries) {
    const captureId = entry.id;
    const destination = destinationOf(draft, captureId);
    switch (destination.kind) {
      case "unselected":
        problems.push({ captureId, reason: "unselected" });
        break;
      case "skip":
        choices.push({ captureId, libraryId: null, folderId: null });
        break;
      case "keepInGroup":
        choices.push({ captureId, libraryId: null, folderId: null, keepInGroup: true });
        break;
      case "collect":
        if (destinationAvailable(destination.destination, providers))
          choices.push({ captureId, libraryId: destination.destination.libraryId, folderId: destination.destination.folderId });
        else problems.push({ captureId, reason: "unavailable" });
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, plan: { target: draft.target, choices } as unknown as CaptureSavePlan<T> };
}
