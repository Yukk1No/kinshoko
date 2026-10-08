import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import { TagIdentityPanel } from "./TagIdentityPanel";

afterEach(() => { cleanup(); clearMocks(); });

it("inspects ambiguous local tags and saves an explicit shared correspondence", async () => {
  const tag = (id: string, name: string) => ({ id, namespace: "general", names: [{ lang: "zh-CN", name }], aliases: [], external: [] });
  const local = (id: string, name: string) => ({ ...tag(id, name), count: 1 });
  const mapping = (libraryId: string, localTagId: string, catalogId: string, name: string) => ({ libraryId, localTagId, catalogId, legacy: local(localTagId, name), basis: "independent", nameProvenance: "pending" });
  let workspace = {
    libraries: [{ library: { id: "a", name: "第一库", root: "a" }, unavailable: null }, { library: { id: "b", name: "第二库", root: "b" }, unavailable: null }],
    catalog: { revision: 1, tags: [tag("blue", "蓝发"), tag("azure", "青丝")], mappings: [mapping("a", "local-a", "blue", "蓝发"), mapping("b", "local-b", "azure", "青丝")] },
  };
  mockIPC((cmd, args) => {
    if (cmd.endsWith("inspect_tag_catalog")) return workspace;
    if (cmd.endsWith("correct_tag_mapping")) {
      const a = args as { libraryId: string; localTagId: string; correction: { kind: string; catalogId: string } };
      expect(a).toEqual({ libraryId: "b", localTagId: "local-b", correction: { kind: "use", catalogId: "blue" } });
      workspace = { ...workspace, catalog: { ...workspace.catalog, revision: 2, mappings: workspace.catalog.mappings.map((m) => m.localTagId === a.localTagId ? { ...m, catalogId: a.correction.catalogId, basis: "corrected" } : m) } };
      return workspace;
    }
  });
  render(<TagIdentityPanel />);
  fireEvent.click(screen.getByRole("button", { name: "检查标签对应" }));
  const row = await screen.findByRole("row", { name: /第二库.*青丝/ });
  fireEvent.change(within(row).getByRole("combobox"), { target: { value: "blue" } });
  fireEvent.click(within(row).getByRole("button", { name: "保存对应" }));
  await within(row).findByText(/已纠正/);
  expect(within(row).getByText("青丝")).toBeTruthy();
  expect(within(row).getByText(/名称来源待处理/)).toBeTruthy();
});

it.each(["inspect", "correct"])("clears inspected records and discards a late %s result when safe mode changes", async (action) => {
  const local = { id: "local", namespace: "general" as const, names: [{ lang: "zh-CN", name: "封印标签" }], aliases: [], external: [], count: 1 };
  const workspace: TagCatalogWorkspace = {
    libraries: [{ library: { id: "a", name: "资料库", root: "a" }, unavailable: null }],
    catalog: { revision: 1, tags: [{ ...local, id: "shared" }, { ...local, id: "other", names: [{ lang: "zh-CN", name: "另一个身份" }] }], mappings: [{ libraryId: "a", localTagId: "local", catalogId: "shared", legacy: local, basis: "independent", nameProvenance: "pending" }] },
  };
  let inspected = false;
  let finish: (workspace: TagCatalogWorkspace) => void = () => { throw new Error("request was not started"); };
  const pending = new Promise<TagCatalogWorkspace>((resolve) => { finish = resolve; });
  mockIPC((cmd) => {
    if (cmd.endsWith("inspect_tag_catalog") && !inspected) { inspected = true; return workspace; }
    if (cmd.endsWith("inspect_tag_catalog") || cmd.endsWith("correct_tag_mapping")) return pending;
  }, { shouldMockEvents: true });
  render(<TagIdentityPanel />);
  fireEvent.click(screen.getByRole("button", { name: "检查标签对应" }));
  const row = await screen.findByRole("row", { name: /资料库.*封印标签/ });
  if (action === "correct") {
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "other" } });
    fireEvent.click(within(row).getByRole("button", { name: "保存对应" }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: "检查标签对应" }));
  }
  await act(async () => { await emit("safe-mode-setting", true); finish(workspace); await pending; });
  expect(screen.queryByRole("row", { name: /资料库.*封印标签/ })).toBeNull();
});