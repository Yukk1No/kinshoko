import { expect, it } from "vitest";
import type { CatalogTag } from "../bindings/CatalogTag";
import { foldName, nameConflict } from "./nameConflict";

const self: CatalogTag = {
  id: "self",
  namespace: "general",
  names: [{ lang: "zh-CN", name: "Self" }],
  defaultNames: [],
  namePreferences: [],
  aliases: [],
  external: [],
};
const other: CatalogTag = {
  ...self,
  id: "other",
  names: [{ lang: "zh-CN", name: "Other" }],
  defaultNames: [{ lang: "en", name: "Underlying" }],
  namePreferences: [{ lang: "ja", name: "Preference" }],
  sourceNames: [{ lang: "und", name: "Source" }],
  aliases: [{ lang: null, name: "Alias" }],
};

it.each(["other", "ＡＬＩＡＳ", "Underlying", "Preference", "Source"])("matches every name layer: %s", (text) => {
  expect(nameConflict([self, other], self, ` ${text} `)).toBe(other);
});

it.each(["", "  ", "Self", "missing", "Ali"])("ignores empty, self and nonmatching words: %s", (text) => {
  expect(nameConflict([self, other], self, text)).toBeUndefined();
});

it("excludes another namespace and handles an empty catalog", () => {
  expect(nameConflict([{ ...other, namespace: "artist" }], self, "Alias")).toBeUndefined();
  expect(nameConflict([], self, "Alias")).toBeUndefined();
});

it("uses Rust's scalar lowercase rather than contextual lowercase or external-mapping normalization", () => {
  expect(foldName(" ΟΣ ")).toBe("οσ");
  expect(foldName("ＢＬＵＥ_ＥＹＥＳ")).toBe("blue_eyes");
  expect(foldName("blue eyes")).not.toBe(foldName("blue_eyes"));
  expect(foldName("e\u0301")).toBe(foldName("é"));
  expect(foldName("\u0085Alias\u0085")).toBe("alias");
  expect(foldName("\uFEFFAlias")).toBe("\uFEFFalias");
});

it("matches an untranslated display name, not an external mapping hidden behind a name", () => {
  const untranslated = { ...other, names: [], external: [{ vocabulary: "danbooru", name: "blue_eyes" }] };
  expect(nameConflict([untranslated], self, "Blue eyes")).toBe(untranslated);
  expect(nameConflict([{ ...untranslated, names: other.names }], self, "Blue eyes")).toBeUndefined();
});
