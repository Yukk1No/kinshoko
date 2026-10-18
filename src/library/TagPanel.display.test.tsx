// 标签的出处与可信度（#160）：标签上只显示名称，模型标签按可信度分档（B，默认）或按出处分组加刻度（C）；
// 出处、精确可信度和操作在悬停或聚焦时的浮层里；未翻译的标签名后面是翻译图标。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagDisplay } from "../bindings/TagDisplay";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagOrigin } from "../bindings/TagOrigin";
import { DEFAULT_TAG_DISPLAY } from "../tags/tagConfidence";
import { TagDisplayContext } from "../tags/TagDisplayContext";
import { TagPanel } from "./TagPanel";

const label = (id: string, name: string, untranslated = false): TagLabel =>
  ({ id, namespace: "general", name, untranslated, hasExternal: true });
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
  ],
  rejected: [label("t-glasses", "眼镜")],
};

function renderPanel(display: TagDisplay = DEFAULT_TAG_DISPLAY) {
  mockIPC((cmd) => {
    if (cmd === "plugin:library|image_tags") return tags;
    if (cmd === "plugin:library|catalog_image_tags") return { identities: [] };
    return null;
  });
  return render(
    <TagDisplayContext.Provider value={display}>
      <TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} />
    </TagDisplayContext.Provider>,
  );
}

const chip = (name: string) => within(screen.getByRole("list", { name: "有效标签" })).getByText(name).closest("li")!;

afterEach(() => { cleanup(); clearMocks(); });

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
    expect(tip.textContent).toContain("来源：打标模型 · 可信度 87%（高）");
    expect(within(tip).getByRole("button", { name: "确认“微笑”" })).toBeTruthy();
    expect(within(tip).getByRole("button", { name: "否决“微笑”" })).toBeTruthy();
  });

  it("悬停标签时也出浮层；人工添加的写“你添加的”", async () => {
    renderPanel();
    await screen.findByText("长发");
    fireEvent.pointerEnter(chip("长发"), { pointerType: "mouse" });
    fireEvent.mouseEnter(chip("长发"));
    fireEvent.mouseMove(chip("长发"));
    const tip = await screen.findByRole("dialog", { name: "“长发”的出处" });
    expect(tip.textContent).toContain("来源：你添加的");
    expect(tip.textContent).toContain("来源：打标模型 · 可信度 99%（高）");
    expect(within(tip).getByRole("button", { name: "清除对“长发”的人工决定" })).toBeTruthy();
  });

  it("低档虚线框默认关，打开后低档标签带虚线框", async () => {
    renderPanel();
    await screen.findByText("窗户");
    expect(screen.getByRole("list", { name: "有效标签" }).dataset.lowOutline).toBeUndefined();
    cleanup();
    renderPanel({ ...DEFAULT_TAG_DISPLAY, lowOutline: true });
    await screen.findByText("窗户");
    expect(screen.getByRole("list", { name: "有效标签" }).dataset.lowOutline).toBe("");
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
  it("分“你添加的 / 打标模型 / 导入”三组，模型组按分数降序，每个模型标签有刻度条", async () => {
    renderPanel({ ...DEFAULT_TAG_DISPLAY, style: "grouped" });
    const manual = await screen.findByRole("list", { name: "你添加的" });
    const models = screen.getByRole("list", { name: "打标模型" });
    const imported = screen.getByRole("list", { name: "导入" });
    const names = (list: HTMLElement) => within(list).getAllByRole("listitem").map((li) => li.querySelector(".tag-name")!.textContent);
    expect(names(manual)).toEqual(["构图练习", "长发"]);
    expect(names(models)).toEqual(["单人", "微笑", "ahoge", "室内", "窗户"]);
    expect(names(imported)).toEqual(["姿势参考"]);
    const meters = within(models).getAllByRole("meter");
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["97", "87", "64", "55", "31"]);
    expect(within(manual).queryAllByRole("meter")).toEqual([]);
    expect(screen.queryByRole("list", { name: "有效标签" })).toBeNull();
  });
});
