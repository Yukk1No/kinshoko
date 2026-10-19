import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagLabel } from "../bindings/TagLabel";
import { DEFAULT_TAG_DISPLAY } from "../tags/tagConfidence";
import { TagDisplayContext } from "../tags/TagDisplayContext";
import { Viewer } from "./Viewer";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const card = { id: "a", width: 800, height: 600, thumbnail: "", adult: false };
const label = (id: string, namespace: TagLabel["namespace"], name: string): TagLabel =>
  ({ id, namespace, name, untranslated: false, hasExternal: true });
const model = (score: number) => ({ kind: "source" as const, source: "model:pixai", score });

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
});
afterEach(() => { cleanup(); clearMocks(); vi.restoreAllMocks(); });

const openInfo = () => {
  fireEvent.keyDown(screen.getByAltText("正在查看的参考图").parentElement!, { key: "i" });
  return screen.getByRole("region", { name: "图片信息" });
};

describe("查看器信息面板的标签（#147）", () => {
  it("按作者、角色、作品、一般分组只读列出有效标签；被否决的不显示，标签上只有名称（#160）", async () => {
    const tags: ImageTags = {
      imageId: "a",
      tags: [
        { tag: label("t1", "general", "短发"), origins: [model(0.91)] },
        { tag: label("t2", "general", "齐刘海"), origins: [{ kind: "manual" }] },
        { tag: label("t3", "artist", "某画师"), origins: [model(0.62)] },
        { tag: label("t4", "work", "某作品"), origins: [{ kind: "manual" }] },
      ],
      rejected: [label("t5", "general", "长发")],
    };
    mockIPC((cmd, args) => {
      if (cmd === "plugin:library|image") return { originalName: "a.png" };
      if (cmd === "plugin:library|image_tags") return { ...tags, imageId: (args as { imageId: string }).imageId };
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const info = openInfo();
    const section = await within(info).findByRole("region", { name: "标签" });
    const groups = within(section).getAllByRole("list").map((list) => list.getAttribute("aria-label"));
    expect(groups).toEqual(["作者", "作品", "一般"]);
    const general = within(section).getByRole("list", { name: "一般" });
    const rows = within(general).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["短发", "齐刘海"]);
    expect(within(section).getByRole("list", { name: "作者" }).textContent).toBe("某画师");
    expect(within(section).getByRole("list", { name: "作品" }).textContent).toBe("某作品");
    expect(section.textContent).not.toContain("长发");
  });

  it("B：模型标签按可信度分档，悬停提示写出处和百分比；未翻译的有翻译图标（#160）", async () => {
    mockIPC((cmd) => {
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") return { imageId: "a", tags: [
        { tag: label("t1", "general", "短发"), origins: [model(0.91)] },
        { tag: label("t2", "general", "室内"), origins: [model(0.55)] },
        { tag: { ...label("t3", "general", "ahoge"), untranslated: true }, origins: [model(0.2)] },
        { tag: label("t4", "general", "齐刘海"), origins: [{ kind: "manual" }] },
      ], rejected: [] };
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const info = openInfo();
    const row = (name: string) => within(info).getByText(name).closest("li")!;
    await within(info).findByText("短发");
    expect(row("短发").dataset.band).toBe("high");
    expect(row("室内").dataset.band).toBe("mid");
    expect(row("ahoge").dataset.band).toBe("low");
    expect(row("齐刘海").dataset.band).toBeUndefined();
    expect(row("短发").title).toBe("来源：打标模型 · 可信度 91%（高）");
    expect(within(row("ahoge")).getByRole("img", { name: "尚无中文名，显示的是原名" })).toBeTruthy();
    expect(info.textContent).not.toContain("文A");
    expect(info.querySelectorAll('[role="meter"]')).toHaveLength(0);
  });

  it("C：仍按命名空间分组，模型标签带刻度条，不按出处分组（#160）", async () => {
    mockIPC((cmd) => {
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") return { imageId: "a", tags: [
        { tag: label("t1", "general", "短发"), origins: [model(0.91)] },
        { tag: label("t2", "general", "齐刘海"), origins: [{ kind: "manual" }] },
        { tag: label("t3", "artist", "某画师"), origins: [model(0.62)] },
      ], rejected: [] };
      return null;
    });
    render(<TagDisplayContext.Provider value={{ ...DEFAULT_TAG_DISPLAY, style: "grouped" }}>
      <Viewer libraryId="L1" card={card} onClose={() => {}} />
    </TagDisplayContext.Provider>);
    const info = openInfo();
    const section = await within(info).findByRole("region", { name: "标签" });
    await within(section).findByText("短发");
    expect(within(section).getAllByRole("list").map((list) => list.getAttribute("aria-label"))).toEqual(["作者", "一般"]);
    const general = within(section).getByRole("list", { name: "一般" });
    expect(within(general).getAllByRole("meter").map((m) => m.getAttribute("aria-valuenow"))).toEqual(["91"]);
    expect(within(section).getByText("短发").closest("li")!.dataset.band).toBeUndefined();
  });

  it("换到下一张时标签跟着换；上一张迟到的结果不写到新图上", async () => {
    const pending = new Map<string, (value: ImageTags) => void>();
    mockIPC((cmd, args) => {
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") {
        const { imageId } = args as { imageId: string };
        return new Promise((resolve) => pending.set(imageId, resolve));
      }
      return null;
    });
    const only = (imageId: string, name: string): ImageTags =>
      ({ imageId, tags: [{ tag: label(`${imageId}-t`, "general", name), origins: [{ kind: "manual" }] }], rejected: [] });
    const { rerender } = render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const info = openInfo();
    await vi.waitFor(() => expect(pending.has("a")).toBe(true));
    rerender(<Viewer libraryId="L1" card={{ ...card, id: "b" }} onClose={() => {}} />);
    await vi.waitFor(() => expect(pending.has("b")).toBe(true));
    await act(async () => pending.get("b")!(only("b", "蓝瞳")));
    await act(async () => pending.get("a")!(only("a", "红瞳")));
    const section = within(info).getByRole("region", { name: "标签" });
    expect(section.textContent).toContain("蓝瞳");
    expect(section.textContent).not.toContain("红瞳");
  });

  it("没有标签时显示“暂无标签”；还在读取时不显示", async () => {
    let finish: (value: ImageTags) => void = () => {};
    mockIPC((cmd) => {
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") return new Promise((resolve) => { finish = resolve; });
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const section = within(openInfo()).getByRole("region", { name: "标签" });
    await act(async () => {});
    expect(section.textContent).not.toContain("暂无标签");
    await act(async () => finish({ imageId: "a", tags: [], rejected: [label("t5", "general", "长发")] }));
    expect(within(section).getByText("暂无标签")).toBeTruthy();
  });

  it("安全模式下被遮蔽的图不显示标签，也不去读", async () => {
    const commands: string[] = [];
    mockIPC((cmd) => {
      commands.push(cmd);
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") return { imageId: "a", tags: [{ tag: label("t1", "general", "短发"), origins: [{ kind: "manual" }] }], rejected: [] };
      return null;
    });
    render(<Viewer libraryId="L1" card={{ ...card, adult: true }} safe onClose={() => {}} />);
    const info = openInfo();
    await act(async () => {});
    expect(within(info).queryByRole("region", { name: "标签" })).toBeNull();
    expect(info.textContent).not.toContain("短发");
    expect(commands).not.toContain("plugin:library|image_tags");
  });

  it("信息面板里没有添加、删除或否决标签的控件", async () => {
    mockIPC((cmd) => {
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") return { imageId: "a", tags: [
        { tag: label("t1", "general", "短发"), origins: [model(0.91)] },
        { tag: label("t2", "character", "某角色"), origins: [{ kind: "manual" }] },
      ], rejected: [label("t5", "general", "长发")] };
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const info = openInfo();
    await within(info).findByText("某角色");
    for (const role of ["button", "textbox", "combobox", "checkbox", "link"] as const)
      expect(within(info).queryAllByRole(role)).toEqual([]);
    expect(info.querySelectorAll("input, select, textarea, button, [contenteditable]")).toHaveLength(0);
  });

  it("在信息面板上滚轮是滚动标签列表，不缩放图片", async () => {
    mockIPC((cmd) => {
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") return { imageId: "a", tags: [{ tag: label("t1", "general", "短发"), origins: [model(0.91)] }], rejected: [] };
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const info = openInfo();
    const zoom = () => screen.getByRole("status", { name: "缩放比例" }).textContent;
    const before = zoom();
    const tag = await within(info).findByText("短发");
    const scrolled = fireEvent.wheel(tag, { deltaY: 100, clientX: 900, clientY: 100 });
    expect(scrolled).toBe(true);
    expect(zoom()).toBe(before);
  });

  it("读取标签失败时说明，不显示“暂无标签”", async () => {
    mockIPC((cmd) => {
      if (cmd === "plugin:library|image") return {};
      if (cmd === "plugin:library|image_tags") throw "资料库暂时不可用";
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const section = within(openInfo()).getByRole("region", { name: "标签" });
    expect(await within(section).findByText("无法读取标签")).toBeTruthy();
    expect(section.textContent).not.toContain("暂无标签");
  });
});
