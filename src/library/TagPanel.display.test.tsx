// 标签的出处与可信度（#160）：标签上只显示名称，模型标签按可信度分档（B，默认）或按出处分组加刻度（C）；
// 出处、精确可信度和操作在悬停或聚焦时的浮层里；未翻译的标签名后面是翻译图标。
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagDisplay } from "../bindings/TagDisplay";
import type { TagLabel } from "../bindings/TagLabel";
import { fakeBackend } from "../test/backend";
import type { TagOrigin } from "../bindings/TagOrigin";
import { DEFAULT_TAG_DISPLAY } from "../tags/tagConfidence";
import { TagDisplayContext } from "../tags/TagDisplayContext";
import { TagPanel } from "./TagPanel";

const label = (id: string, name: string, untranslated = false, namespace: TagLabel["namespace"] = "general"): TagLabel =>
  ({ id, namespace, name, untranslated, hasExternal: true });
const model = (score: number | null): TagOrigin => ({ kind: "source", source: "model:pixai", score });
const eagle: TagOrigin = { kind: "source", source: "eagle:lib1", score: null };

const tags: ImageTags = {
  imageId: "a",
  tags: [
    { tag: label("t-comp", "构图练习"), origins: [{ kind: "manual" }] },
    { tag: label("t-hair", "长发"), origins: [{ kind: "manual" }, model(0.99)] },
    { tag: label("t-smile", "微笑"), origins: [model(0.87)] },
    { tag: label("t-indoor", "室内"), origins: [model(0.55)] },
    { tag: label("t-ahoge", "ahoge", true), origins: [model(0.64)] },
    { tag: label("t-window", "窗户"), origins: [model(0.31)] },
    { tag: label("t-solo", "单人"), origins: [model(0.42), { kind: "source", source: "model:other", score: 0.97 }] },
    { tag: label("t-pose", "姿势参考"), origins: [eagle] },
    { tag: label("t-sketch", "草图"), origins: [model(null)] },
  ],
  rejected: [label("t-glasses", "眼镜")],
};

function renderPanel(display: TagDisplay = DEFAULT_TAG_DISPLAY, image: ImageTags = tags, rating?: { label: string; control: ReactNode }) {
  fakeBackend({ catalog_image_tags: { image, identities: [] } });
  return render(
    <TagDisplayContext value={display}>
      <TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} rating={rating} />
    </TagDisplayContext>,
  );
}

const chip = (name: string) => within(screen.getByRole("list", { name: "有效标签" })).getByText(name).closest("li")!;

describe("B：可信度三档底色（默认）", () => {
  it("标签上只有名称，没有“模型 0.xx”“人工添加”“Eagle”等文字", async () => {
    renderPanel();
    const list = await screen.findByRole("list", { name: "有效标签" });
    await waitFor(() => expect(list.textContent).toContain("微笑"));
    for (const text of ["模型", "人工添加", "Eagle", "参考组包", "0.87", "文A"]) expect(list.textContent).not.toContain(text);
  });

  it("模型标签按最高分分档；人工添加的和导入的不分档", async () => {
    renderPanel();
    await screen.findByText("微笑");
    expect(chip("微笑").dataset.band).toBe("high");
    expect(chip("室内").dataset.band).toBe("mid");
    expect(chip("窗户").dataset.band).toBe("low");
    expect(chip("单人").dataset.band).toBe("high");
    expect(chip("长发").dataset.band).toBeUndefined();
    expect(chip("长发").className).toContain("is-manual");
    expect(chip("姿势参考").dataset.band).toBeUndefined();
  });

  it("阈值改了，档位跟着变，不需要重新打标", async () => {
    renderPanel({ ...DEFAULT_TAG_DISPLAY, high: 0.5, low: 0.35 });
    await screen.findByText("微笑");
    expect(chip("室内").dataset.band).toBe("high");
    expect(chip("窗户").dataset.band).toBe("low");
  });

  it("聚焦标签时浮层写出处和百分比，操作按钮也在浮层里", async () => {
    renderPanel();
    await screen.findByText("微笑");
    fireEvent.focus(chip("微笑"));
    const tip = await screen.findByRole("dialog", { name: "“微笑”的出处" });
    expect(tip.textContent).toContain("自动标签，可信度 87%（高）");
    expect(within(tip).getByRole("button", { name: "保留“微笑”" })).toBeTruthy();
    expect(within(tip).getByRole("button", { name: "排除“微笑”" })).toBeTruthy();
  });

  it("悬停标签时也出浮层；人工添加的写“你添加的”", async () => {
    renderPanel();
    await screen.findByText("长发");
    fireEvent.pointerEnter(chip("长发"), { pointerType: "mouse" });
    fireEvent.mouseEnter(chip("长发"));
    fireEvent.mouseMove(chip("长发"));
    const tip = await screen.findByRole("dialog", { name: "“长发”的出处" });
    expect(tip.textContent).toContain("来源：你添加的");
    expect(tip.textContent).toContain("自动标签，可信度 99%（高）");
    expect(within(tip).getByRole("button", { name: "把“长发”改回自动" })).toBeTruthy();
  });

  it("没有分数的模型标签按中档；人写的排在前面，模型标签按可信度从高到低（#482）", async () => {
    renderPanel();
    const list = await screen.findByRole("list", { name: "有效标签" });
    await screen.findByText("草图");
    expect(chip("草图").dataset.band).toBe("mid");
    expect(within(list).getAllByRole("listitem").map((li) => li.querySelector(".tag-name")!.textContent))
      .toEqual(["构图练习", "长发", "姿势参考", "单人", "微笑", "ahoge", "室内", "窗户", "草图"]);
  });

  it("浮层里只有打标模型那行前面有星（#482）", async () => {
    renderPanel();
    await screen.findByText("长发");
    fireEvent.focus(chip("长发"));
    const tip = await screen.findByRole("dialog", { name: "“长发”的出处" });
    const line = (text: string) => within(tip).getByText(text, { exact: false }).closest(".k-tag-tip-line")!;
    expect(line("自动标签，可信度 99%").querySelector("svg")).not.toBeNull();
    expect(line("来源：你添加的").querySelector("svg")).toBeNull();
  });
});

describe("悬停不改标签尺寸（#159）", () => {
  it("浮层渲染在标签外面，打开前后标签里的内容不变", async () => {
    renderPanel();
    await screen.findByText("微笑");
    const before = chip("微笑").innerHTML;
    fireEvent.pointerEnter(chip("微笑"), { pointerType: "mouse" });
    fireEvent.mouseEnter(chip("微笑"));
    fireEvent.mouseMove(chip("微笑"));
    const tip = await screen.findByRole("dialog", { name: "“微笑”的出处" });
    expect(chip("微笑").contains(tip)).toBe(false);
    expect(chip("微笑").innerHTML).toBe(before);
  });
});

describe("未翻译的标签", () => {
  it("名称后面是翻译图标，带可访问名称；不再出现“文A”", async () => {
    renderPanel();
    await screen.findByText("ahoge");
    const icon = within(chip("ahoge")).getByRole("img", { name: "尚无中文名，显示的是原名" });
    expect(icon.tagName.toLowerCase()).toBe("span");
    expect(document.body.textContent).not.toContain("文A");
    fireEvent.focus(chip("ahoge"));
    const tip = await screen.findByRole("dialog", { name: "“ahoge”的出处" });
    expect(tip.textContent).toContain("尚无中文名，显示的是原名");
  });
});

describe("C：按出处分组＋可信度刻度", () => {
  it("分“你添加的 / 导入 / 自动标签”三组（#482），模型组按分数降序，有分数的模型标签有刻度条", async () => {
    renderPanel({ ...DEFAULT_TAG_DISPLAY, style: "grouped" });
    const manual = await screen.findByRole("list", { name: "你添加的" });
    const models = screen.getByRole("list", { name: "自动标签" });
    const imported = screen.getByRole("list", { name: "导入" });
    const titles = [...document.querySelectorAll(".k-tag-group > .k-tags-sub")];
    expect(titles.map((p) => p.textContent)).toEqual(["你添加的", "导入", "自动标签"]);
    expect(titles.map((p) => p.querySelector("svg") !== null)).toEqual([false, false, true]);
    const names = (list: HTMLElement) => within(list).getAllByRole("listitem").map((li) => li.querySelector(".tag-name")!.textContent);
    expect(names(manual)).toEqual(["构图练习", "长发"]);
    expect(names(models)).toEqual(["单人", "微笑", "ahoge", "室内", "窗户", "草图"]);
    expect(names(imported)).toEqual(["姿势参考"]);
    const meters = within(models).getAllByRole("meter");
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["97", "87", "64", "55", "31"]);
    expect(within(manual).queryAllByRole("meter")).toEqual([]);
    expect(screen.queryByRole("list", { name: "有效标签" })).toBeNull();
  });
});

describe("一级标签：作者、角色、作品在属性表里各占一行（#518）", () => {
  const primary: ImageTags = {
    imageId: "a",
    tags: [
      { tag: label("t-hair", "长发"), origins: [model(0.9)] },
      { tag: label("t-work", "VOCALOID", false, "work"), origins: [eagle] },
      { tag: label("t-luka", "巡音流歌", false, "character"), origins: [model(0.55)] },
      { tag: label("t-miku", "初音未来", false, "character"), origins: [{ kind: "manual" }] },
      { tag: label("t-artist", "米山舞", false, "artist"), origins: [eagle] },
    ],
    rejected: [label("t-rin", "镜音铃", false, "character")],
  };
  const rows = () => [...document.querySelectorAll(".insp-props > .insp-prop")].map((row) =>
    [row.querySelector("dt")!.textContent, ...[...row.querySelectorAll(".tag-name")].map((name) => name.textContent)]);

  it("按“作者 / 角色 / 作品”排，行首写类别，标签上不写前缀；一般标签留在“标签”区", async () => {
    renderPanel(DEFAULT_TAG_DISPLAY, primary);
    await screen.findByText("初音未来");
    // 行内也是人写的在前、模型标签在后。
    expect(rows()).toEqual([["作者", "米山舞"], ["角色", "初音未来", "巡音流歌"], ["作品", "VOCALOID"]]);
    expect(document.querySelector(".insp-props")!.textContent).not.toContain("：");
    const general = screen.getByRole("list", { name: "有效标签" });
    expect(within(general).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["长发"]);
  });

  it("三档外观和浮层照旧，浮层的名称带类别", async () => {
    renderPanel(DEFAULT_TAG_DISPLAY, primary);
    const luka = (await screen.findByText("巡音流歌")).closest("li")!;
    expect(luka.dataset.band).toBe("mid");
    fireEvent.focus(luka);
    const tip = await screen.findByRole("dialog", { name: "“角色：巡音流歌”的出处" });
    expect(within(tip).getByRole("button", { name: "排除“角色：巡音流歌”" })).toBeTruthy();
  });

  it("没有标签的类别不占行；已排除的一级标签写全名，列在“已排除”里", async () => {
    renderPanel(DEFAULT_TAG_DISPLAY, { ...primary, tags: primary.tags.filter((entry) => entry.tag.namespace !== "character") });
    await screen.findByText("米山舞");
    expect(rows()).toEqual([["作者", "米山舞"], ["作品", "VOCALOID"]]);
    const excluded = screen.getByRole("list", { name: "已排除" });
    expect(excluded.textContent).toBe("角色：镜音铃");
    expect(within(excluded).getByRole("button", { name: "把“角色：镜音铃”改回自动" })).toBeTruthy();
  });

  it("分级是最后一行；只有一级标签时“标签”区不写“还没有标签”", async () => {
    renderPanel(DEFAULT_TAG_DISPLAY, { ...primary, tags: primary.tags.filter((entry) => entry.tag.namespace === "artist") }, { label: "分级", control: <span>控件</span> });
    await screen.findByText("米山舞");
    expect([...document.querySelectorAll(".insp-props > .insp-prop > dt")].map((dt) => dt.textContent)).toEqual(["作者", "分级"]);
    expect(screen.queryByText("还没有标签")).toBeNull();
    expect(screen.queryByRole("list", { name: "有效标签" })).toBeNull();
  });

  it("一张标签都没有时没有属性表，“标签”区写“还没有标签”", async () => {
    renderPanel(DEFAULT_TAG_DISPLAY, { imageId: "a", tags: [], rejected: [] });
    expect(await screen.findByText("还没有标签")).toBeTruthy();
    expect(document.querySelector(".insp-props")).toBeNull();
  });
});
