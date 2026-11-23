import type { CatalogTag } from "../bindings/CatalogTag";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { LibraryTagMapping } from "../bindings/LibraryTagMapping";

// Match Rust search::fold: NFKC, then lowercase each Unicode scalar independently.
export const foldName = (text: string) =>
  Array.from(text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").normalize("NFKC"), (character) =>
    character.toLowerCase(),
  ).join("");

export function nameConflict(
  tags: readonly CatalogTag[],
  self: { id?: string; namespace: TagNamespace },
  text: string,
  mappings: readonly LibraryTagMapping[] = [],
) {
  const word = foldName(text);
  if (!word) return undefined;
  const retainedMatches = new Set(
    mappings
      .filter(
        (mapping) =>
          mapping.nameProvenance === "pending" &&
          [...mapping.legacy.names, ...mapping.legacy.aliases].some((name) => foldName(name.name) === word),
      )
      .map((mapping) => mapping.catalogId),
  );
  return tags.find(
    (tag) =>
      tag.id !== self.id &&
      tag.namespace === self.namespace &&
      (retainedMatches.has(tag.id) ||
        [
          ...tag.names,
          ...tag.defaultNames,
          ...tag.namePreferences,
          ...(tag.sourceNames ?? []),
          ...tag.aliases,
          ...(tag.names.length === 0 && tag.external.length > 0
            ? [{ name: tag.external[0].name.replaceAll("_", " ") }]
            : []),
        ].some((name) => foldName(name.name) === word)),
  );
}
