import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { EagleTagMapping } from "../bindings/EagleTagMapping";
import type { TagLabel } from "../bindings/TagLabel";
import { fakeBackend } from "../test/backend";
import { EagleTagStep } from "./EagleTagStep";

const tag = (id: string, name: string, hasExternal: boolean): TagLabel => ({
  id,
  namespace: "general",
  name,
  untranslated: false,
  hasExternal,
});

const mapping: EagleTagMapping = {
  matched: [
    { tag: tag("t-blue", "蓝瞳", true), count: 5, external: ["blue_eyes"], basis: "name", mergedInto: null },
    { tag: tag("t-raw", "blue eyes", false), count: 5, external: ["blue_eyes"], basis: "name", mergedInto: tag("t-blue", "蓝瞳", true) },
  ],
  unmatched: [
    { tag: tag("t-aqua", "水色", false), count: 3, candidates: [] },
    { tag: tag("t-own", "自造", false), count: 1, candidates: [] },
  ],
  vocabularySize: 1200,
};

function backend() {
  return fakeBackend({
    eagle_tag_mapping: mapping,
    external_suggestions: ["aqua_eyes"],
    map_tag_external: { external: "aqua_eyes", known: true, mergedInto: null },
  });
}

describe("迁入向导：标签的外部对应", () => {
  it("列出没对上的标签，没有外部对应的带提示图标", async () => {
    backend();
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);

    const list = await screen.findByRole("list", { name: "未匹配外部对应的标签" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByRole("img", { name: "没有外部对应，不参与内置相近标签" })).toHaveLength(2);
    expect(screen.getByText(/已自动匹配 2 个标签/)).toBeTruthy();
  });

  it("外部对应已属于另一个标签的 Eagle 标签注明已并入它", async () => {
    backend();
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);

    const list = await screen.findByRole("list", { name: "已并入其他标签" });
    expect(within(list).getByText("blue eyes 已并入 蓝瞳")).toBeTruthy();
  });

  it("画师给一个标签补上外部对应，它从列表中移除", async () => {
    const fake = backend();
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);

    const input = await screen.findByRole("combobox", { name: "水色 的外部对应" });
    fireEvent.change(input, { target: { value: "Aqua Eyes" } });
    fireEvent.click(screen.getByRole("button", { name: "补上 水色 的外部对应" }));

    expect(await screen.findByText(/水色 → aqua_eyes/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "水色 的外部对应" })).toBeNull();
    expect(fake.calls()).toContainEqual({
      command: "map_tag_external",
      args: { libraryId: "L1", tagId: "t-aqua", external: "Aqua Eyes" },
    });
  });

  it("补上外部对应失败时，界面上能看到标签名和后端给的说明", async () => {
    fakeBackend({
      eagle_tag_mapping: mapping,
      external_suggestions: [],
      map_tag_external: () => { throw { code: "unknownTag" }; },
    });
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);

    const input = await screen.findByRole("combobox", { name: "水色 的外部对应" });
    fireEvent.change(input, { target: { value: "Aqua Eyes" } });
    fireEvent.click(screen.getByRole("button", { name: "补上 水色 的外部对应" }));

    expect(await screen.findByText("无法给 水色 补上外部对应：图库中没有这个标签")).toBeTruthy();
  });

  it("用 ↓ 高亮一个候选再回车，只补上这一个，不再另按输入补一次", async () => {
    const fake = backend();
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);

    const input = await screen.findByRole("combobox", { name: "水色 的外部对应" });
    input.focus();
    fireEvent.change(input, { target: { value: "aqua" } });
    await screen.findByRole("option", { name: "aqua_eyes" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(/水色 → aqua_eyes/)).toBeTruthy();
    expect(fake.calls("map_tag_external")).toEqual([
      { command: "map_tag_external", args: { libraryId: "L1", tagId: "t-aqua", external: "aqua_eyes" } },
    ]);
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
