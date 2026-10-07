import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { EagleTagMapping } from "../bindings/EagleTagMapping";
import type { TagLabel } from "../bindings/TagLabel";
import { EagleTagStep } from "./EagleTagStep";

afterEach(() => {
  cleanup();
  clearMocks();
});

const tag = (id: string, name: string, hasExternal: boolean): TagLabel => ({
  id,
  namespace: "general",
  name,
  untranslated: false,
  hasExternal,
});

const mapping: EagleTagMapping = {
  matched: [{ tag: tag("t-blue", "blue eyes", true), count: 5, external: ["blue_eyes"], basis: "name" }],
  unmatched: [
    { tag: tag("t-aqua", "水色", false), count: 3, candidates: [], takenBy: null, takenExternal: null },
    { tag: tag("t-own", "自造", false), count: 1, candidates: [], takenBy: null, takenExternal: null },
  ],
  vocabularySize: 1200,
};

function backend() {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "plugin:library|eagle_tag_mapping") return mapping;
    if (cmd === "plugin:library|external_suggestions") return ["aqua_eyes"];
    if (cmd === "plugin:library|map_tag_external") return { external: "aqua_eyes", known: true };
    return undefined;
  });
  return calls;
}

describe("迁入向导：标签的外部对应", () => {
  it("说明没有外部对应的影响，列出没对上的标签并带提示图标", async () => {
    backend();
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);

    const list = await screen.findByRole("list", { name: "没对上外部对应的标签" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByRole("img", { name: "没有外部对应，不参与内置近似对应表" })).toHaveLength(2);
    expect(screen.getByText(/已自动对上 1 个标签/)).toBeTruthy();
    expect(screen.getByText(/不参与内置近似对应表/, { selector: "p" })).toBeTruthy();
  });

  it("画师给一个标签补上外部对应，它从列表中移除", async () => {
    const calls = backend();
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);

    const input = await screen.findByRole("combobox", { name: "水色 的外部对应" });
    fireEvent.change(input, { target: { value: "Aqua Eyes" } });
    fireEvent.click(screen.getByRole("button", { name: "补上 水色 的外部对应" }));

    expect(await screen.findByText(/水色 → aqua_eyes/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "水色 的外部对应" })).toBeNull();
    expect(calls).toContainEqual({
      cmd: "plugin:library|map_tag_external",
      args: { libraryId: "L1", tagId: "t-aqua", external: "Aqua Eyes" },
    });
  });

  it("可以逐个跳过，也可以全部跳过", async () => {
    backend();
    let closed = false;
    render(<EagleTagStep libraryId="L1" onClose={() => (closed = true)} />);

    fireEvent.click(await screen.findByRole("button", { name: "跳过 自造" }));
    expect(screen.queryByRole("combobox", { name: "自造 的外部对应" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "水色 的外部对应" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "全部跳过" }));
    expect(closed).toBe(true);
  });
});
