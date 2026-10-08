// Existing one-provider UI fixtures projected onto the workspace IPC contract.
// The product never uses this adapter; real provider semantics are tested in Rust/native E2E.
import type { Sidebar } from "../bindings/Sidebar";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { BrowsePage } from "../bindings/BrowsePage";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
type Handler = (cmd: string, args?: unknown) => unknown;
export function workspaceFixture(handler: Handler): Handler {
  let active: LibraryInfo | null | undefined;
  return (command, arguments_) => {
    const args = (arguments_ ?? {}) as Record<string, unknown>;
    const current = () => active !== undefined ? active : handler("plugin:library|current_library") as LibraryInfo | null;
    if (["current_library", "switch_library", "register_library", "create_library"].some((name) => command === "plugin:library|" + name)) {
      const value = handler(command, arguments_);
      return Promise.resolve(value).then((library) => { active = library as LibraryInfo | null; return library; });
    }
    if (command === "plugin:library|unregister_library") { active = null; return handler(command, arguments_); }
    if (command === "plugin:library|workspace_status") {
      return Promise.resolve(handler("plugin:library|registered_libraries")).then((libraries) => ({
        revision: "fixture", libraries: (libraries ?? []) as LibraryRegistration[],
      }));
    }
    if (command === "plugin:library|workspace_directories") {
      return Promise.resolve(handler("plugin:library|registered_libraries")).then(async (value) => {
        const libraries = (value ?? []) as LibraryRegistration[];
        return { status: { revision: "fixture", libraries }, providers: await Promise.all(libraries.map(async (registration) => ({
          registration, unassigned: 0, sidebar: registration.unavailable ? null : await handler("plugin:library|sidebar", { libraryId: registration.library.id }) as Sidebar,
        }))) } satisfies WorkspaceDirectories;
      });
    }
    if (command === "plugin:library|workspace_local_tags") return args.ids;
    if (command === "plugin:library|workspace_browse") {
      const query = args.query as { scope: { kind: string; libraryId?: string; scope?: unknown } };
      const library = current();
      const libraryId = query.scope.libraryId ?? library?.id ?? "L1";
      return Promise.resolve(handler("plugin:library|browse", { libraryId, query: {
        ...query, scope: query.scope.kind === "library" ? query.scope.scope : { kind: "all" },
      } })).then((page) => {
        const result = page as BrowsePage;
        return { ...result, status: { revision: "fixture", libraries: [] },
          cards: result.cards.map((card) => ({ ...card, libraryId, imageId: card.id, sources: [{
            libraryId, libraryName: library?.name ?? "fixture", imageId: card.id, matches: true, unavailable: null, deleted: false,
          }] })),
        } satisfies WorkspacePage;
      });
    }
    const remap: Record<string, string> = {
      workspace_image: "image", workspace_sidebar: "sidebar", workspace_resolve: "resolve_search",
      workspace_candidates: "search_candidates", workspace_tag_groups: "tag_groups",
    };
    const name = command.replace("plugin:library|", "");
    if (remap[name]) return handler("plugin:library|" + remap[name], { libraryId: current()?.id ?? "L1", ...args });
    return handler(command, arguments_);
  };
}
