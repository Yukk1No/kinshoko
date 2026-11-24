import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CatalogTag } from "../bindings/CatalogTag";
import { fakeBackend } from "../test/backend";
import { UntranslatedRename } from "../tags/UntranslatedRename";
import { TagNamePanel } from "./TagNamePanel";
import { AliasEditor } from "./TagAliasEditor";

const tag: CatalogTag = {
  id: "self",
  namespace: "general",
  names: [{ lang: "zh-CN", name: "Self" }],
  defaultNames: [],
  namePreferences: [],
  aliases: [{ lang: null, name: "Self alias" }],
  external: [],
};
const other: CatalogTag = {
  ...tag,
  id: "other",
  names: [{ lang: "zh-CN", name: "Other" }],
  defaultNames: [{ lang: "en", name: "Hidden name" }],
  aliases: [{ lang: "ja", name: "Other alias" }],
};
const label = { id: "self", namespace: "general" as const, name: "Self", untranslated: true, hasExternal: false };
const workspace = {
  libraries: [],
  catalog: {
    revision: 1,
    tags: [tag, other, { ...other, id: "artist", namespace: "artist", names: [{ lang: "en", name: "Artist" }] }],
    mappings: [
      {
        libraryId: "L",
        localTagId: "local-other",
        catalogId: "other",
        nameProvenance: "pending",
        basis: "external",
        legacy: {
          id: "local-other",
          namespace: "general",
          names: [{ lang: "en", name: "Retained name" }],
          aliases: [{ lang: null, name: "Retained alias" }],
          external: [],
          count: 1,
        },
      },
    ],
  },
};

for (const surface of ["settings rename", "settings alias", "popover rename", "detail alias"] as const) {
  it(`${surface}: warns for another name/alias but not self, another namespace, empty or unrelated text; allows saving`, async () => {
    const onSaved = vi.fn();
    const backend = fakeBackend({
      inspect_tag_catalog: workspace,
      tag_name_conflict_tags: [
        other,
        { ...other, id: "artist", namespace: "artist", names: [{ lang: "en", name: "Artist" }], aliases: [] },
      ],
      vocabulary: { tags: [] },
      edit_tag_name: workspace,
      add_tag_alias: null,
    });
    let input: HTMLElement;
    let save: HTMLButtonElement;
    if (surface.startsWith("settings")) {
      render(<TagNamePanel />);
      fireEvent.click(await screen.findByRole("button", { name: "重命名“Self”" }));
      input = screen.getByRole("textbox", {
        name: surface === "settings rename" ? "“Self”的显示名" : "“Self”的新别名",
      });
      save = screen.getByRole("button", { name: surface === "settings rename" ? "保存显示名" : "添加别名" });
    } else if (surface === "popover rename") {
      render(<UntranslatedRename tag={label} catalogId="self" onSaved={onSaved} />);
      fireEvent.click(screen.getByRole("button", { name: "重命名“Self”" }));
      input = screen.getByRole("textbox", { name: "显示名" });
      save = screen.getByRole("button", { name: "保存显示名" });
    } else {
      render(<AliasEditor libraryId="L" tag={label} generation={0} onError={vi.fn()} onClose={vi.fn()} />);
      input = screen.getByRole("textbox");
      save = screen.getByRole("button", { name: "添加别名" });
    }
    for (const text of [
      " Other ",
      "ＯＴＨＥＲ ＡＬＩＡＳ",
      "hidden name",
      ...(surface === "detail alias" ? [] : ["Retained name", "Retained alias"]),
    ]) {
      fireEvent.change(input, { target: { value: text } });
      const warning = await screen.findByRole("status");
      expect(warning.className).toBe("k-list-desc is-warn");
      expect(warning.textContent).toContain("Other");
      expect(warning.querySelector("svg")).toBeTruthy();
      expect(save.disabled).toBe(false);
    }
    for (const text of ["", "Self", "Self alias", "Artist", "unrelated"]) {
      fireEvent.change(input, { target: { value: text } });
      expect(screen.queryByRole("status")).toBeNull();
    }
    fireEvent.change(input, { target: { value: "Other alias" } });
    await screen.findByRole("status");
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        backend.calls(surface.endsWith("alias") && !surface.startsWith("settings") ? "add_tag_alias" : "edit_tag_name"),
      ).toHaveLength(1),
    );
    if (surface === "popover rename") await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(within(document.body).queryByRole("alert")).toBeNull();
  });
}

it("keeps detail alias saving available when the warning query fails", async () => {
  const backend = fakeBackend({
    vocabulary: { tags: [] },
    tag_name_conflict_tags: () => Promise.reject(new Error("unavailable")),
    add_tag_alias: null,
  });
  render(<AliasEditor libraryId="L" tag={label} generation={0} onError={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Other" } });
  fireEvent.click(screen.getByRole("button", { name: "添加别名" }));
  await waitFor(() => expect(backend.calls("add_tag_alias")).toHaveLength(1));
  expect(screen.queryByRole("status")).toBeNull();
});
