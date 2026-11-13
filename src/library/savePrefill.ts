import type { SaveDestination } from "../bindings/SaveDestination";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { parentFolder } from "./library-path";
import { folderChoices } from "./SaveDestination";

/**
 * 保存入口的预填（ADR-0016）：每个入口按动作的确定性选依据，不设跨入口共用的默认资料库。
 * 预填只决定往哪里存，不影响浏览范围；取不到时落到登记最早的可用资料库，一个都没有时留空。
 */

const usable = (provider: WorkspaceDirectory) => !provider.registration.unavailable && !!provider.sidebar;

/** 这个位置现在能不能存：资料库不可用时不能；文件夹已删除时落到那个资料库的未归类。 */
function settle(destination: SaveDestination | null, providers: WorkspaceDirectory[]): SaveDestination | null {
  const provider = providers.find((p) => p.registration.library.id === destination?.libraryId);
  if (!destination || !provider || !usable(provider)) return null;
  const folderExists = folderChoices(provider.sidebar?.folders ?? []).some(
    (folder) => folder.id === destination.folderId,
  );
  return folderExists ? destination : { libraryId: destination.libraryId, folderId: null };
}

/** 导入：浏览范围指了位置就用它（资料库的全部按未归类），「全部图片」下用导入上次亲手选的。 */
export function importPrefill(
  scope: WorkspaceScope | undefined,
  remembered: SaveDestination | null,
  providers: WorkspaceDirectory[],
): SaveDestination | null {
  const inFolder = scope?.kind === "library" && (scope.scope.kind === "folder" || scope.scope.kind === "folderTree");
  const pointed =
    scope?.kind === "library"
      ? { libraryId: scope.libraryId, folderId: inFolder && "id" in scope.scope ? scope.scope.id : null }
      : null;
  const earliest = providers.find(usable);
  return (
    settle(pointed, providers) ??
    settle(remembered, providers) ??
    (earliest ? { libraryId: earliest.registration.library.id, folderId: null } : null)
  );
}

/** 新建榜单资料库的位置：已有榜单订阅所在资料库的旁边（`rankingLibraries` 先订的在前）→ 上次新建资料库的位置 → 登记最早的资料库旁边。 */
export function newLibraryParentPrefill(
  rankingLibraries: string[],
  remembered: string | null,
  providers: WorkspaceDirectory[],
): string | null {
  const beside = (provider: WorkspaceDirectory | undefined) =>
    provider ? parentFolder(provider.registration.library.root) : null;
  const ranking = [...rankingLibraries]
    .reverse()
    .map((id) => providers.find((p) => p.registration.library.id === id && usable(p)))
    .find(Boolean);
  return beside(ranking) ?? remembered ?? beside(providers.find(usable));
}

/** 新建图库的位置：和已有的图库放在一起（上次新建资料库的位置 → 登记最早的资料库旁边）→ 系统的「图片」文件夹。 */
export function createLibraryParentPrefill(
  remembered: string | null,
  providers: WorkspaceDirectory[],
  pictures: string | null,
): string | null {
  return newLibraryParentPrefill([], remembered, providers) ?? pictures;
}
