import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { BrowserCard } from "../wall/wallShared";
import { Viewer } from "./Viewer";
import { useViewerFlight } from "./ViewerFlight";

const LANDED = { timeout: 4000 };
const makeCard = (id: string, adult = false) => ({ id, libraryId: "L1", imageId: id, width: 1000, height: 800, adult, thumbnail: "" }) as unknown as BrowserCard;
const cards = { a: makeCard("a"), b: makeCard("b"), far: makeCard("far"), r18: makeCard("r18", true), veil: makeCard("veil", true) };

/** 图片墙的替身：`a`、`b`、`r18`、`veil` 在视口里，`far` 滚出了视口，`gone` 不在墙上。 */
function Harness({ initial = null, safe = false, instant = false }: { initial?: BrowserCard | null; safe?: boolean; instant?: boolean }) {
  const [viewing, setViewing] = useState<BrowserCard | null>(initial);
  const host = useRef<HTMLDivElement>(null);
  const flight = useViewerFlight({ viewing, safe, host, instant });
  return (
    <div className="wall-host" ref={host}>
      <div className="wall" data-testid="wall">
        <div className="card" data-id="a" data-rect="10,20,100,80"><img src="thumb://a" /></div>
        <div className="card" data-id="b" data-rect="200,300,100,80"><img src="thumb://b" /></div>
        <div className="card" data-id="far" data-rect="10,5000,100,80"><img src="thumb://far" /></div>
        <div className="card" data-id="r18" data-rect="10,120,100,80" data-leaving={safe}><img src="thumb://r18" /></div>
        <div className="card" data-id="veil" data-rect="10,220,100,80" data-veiled="true"><img src="thumb://veil" /></div>
      </div>
      {Object.values(cards).map((card) => <button key={card.id} onClick={() => setViewing(card)}>{`open-${card.id}`}</button>)}
      <button onClick={() => setViewing(makeCard("gone"))}>open-gone</button>
      <button onClick={() => setViewing(null)}>close</button>
      {flight.card && <Viewer key={flight.session} libraryId="L1" card={flight.card} onClose={() => setViewing(null)}
        flight={flight.attr} hideImage={flight.hideImage} onPlaced={flight.onPlaced} />}
      {flight.flier}
    </div>
  );
}

const flier = () => document.querySelector<HTMLElement>(".viewer-flier");
const viewer = () => document.querySelector<HTMLElement>(".viewer");
const original = () => screen.getByAltText("正在查看的参考图") as HTMLImageElement;
const press = (name: string) => fireEvent.click(screen.getByText(name));
/** 让查看器的位图读完。 */
const loadOriginal = async () => { await act(async () => { fireEvent.load(original()); await Promise.resolve(); }); };

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rect = this.dataset.rect?.split(",").map(Number);
    return rect ? new DOMRect(rect[0], rect[1], rect[2], rect[3]) : new DOMRect(0, 0, 1000, 800);
  });
  mockConvertFileSrc("windows");
  mockIPC(() => null);
});
afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-reduced-motion");
  document.documentElement.style.removeProperty("--t");
});

describe("打开", () => {
  it("缩略图从卡片飞到查看区，到位并读完原图后才换下；顶栏与 Dock 等到位后进入", async () => {
    render(<Harness />);
    press("open-a");
    expect(viewer()!.dataset.flight).toBe("fly-in");
    expect(flier()!.querySelector("img")!.getAttribute("src")).toBe("thumb://a");
    expect(flier()!.style.left).toBe("10px");
    expect(flier()!.style.top).toBe("20px");
    expect(document.querySelector<HTMLElement>('.card[data-id="a"]')!.dataset.flying).toBe("");
    expect(original().style.visibility).toBe("hidden");

    await waitFor(() => expect(viewer()!.dataset.flight).toBeUndefined(), LANDED);
    // 到位了，原图还没读完：缩略图留着顶住，不出现空白或“正在读取”。
    expect(flier()).not.toBeNull();
    expect(original().style.visibility).toBe("hidden");
    expect(screen.queryByText("正在读取参考图…")).toBeNull();

    await loadOriginal();
    await waitFor(() => expect(flier()).toBeNull());
    expect(original().style.visibility).toBe("visible");
    expect(document.querySelector<HTMLElement>('.card[data-id="a"]')!.dataset.flying).toBeUndefined();
  });

  it("原图读取失败时不再遮着错误提示", async () => {
    render(<Harness />);
    press("open-a");
    await waitFor(() => expect(viewer()!.dataset.flight).toBeUndefined(), LANDED);
    fireEvent.error(original());
    await waitFor(() => expect(flier()).toBeNull());
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("飞行中换图：直接到位", () => {
    render(<Harness />);
    press("open-a");
    press("open-b");
    expect(flier()).toBeNull();
    expect(viewer()!.dataset.flight).toBeUndefined();
    expect(document.querySelector<HTMLElement>('.card[data-id="a"]')!.dataset.flying).toBeUndefined();
  });
});

describe("返回", () => {
  const openSettled = async (name: string) => {
    press(name);
    await waitFor(() => expect(viewer()!.dataset.flight).toBeUndefined(), LANDED);
    await loadOriginal();
    await waitFor(() => expect(flier()).toBeNull());
  };

  it("缩回正在看的那张的卡片，顶栏与 Dock 先退出，落地后查看器才卸下", async () => {
    render(<Harness />);
    await openSettled("open-a");
    press("close");
    expect(viewer()!.dataset.flight).toBe("land");
    expect(viewer()!.hasAttribute("inert")).toBe(true);
    expect(flier()!.style.left).toBe("10px");
    expect(flier()!.style.top).toBe("20px");
    expect(original().style.visibility).toBe("hidden");
    // 从查看器已读完的位图起飞，不先跳回模糊的缩略图。
    expect(flier()!.querySelector("img")!.getAttribute("src")).toBe(original().getAttribute("src"));
    await waitFor(() => expect(viewer()).toBeNull(), LANDED);
    expect(flier()).toBeNull();
    expect(document.querySelector<HTMLElement>('.card[data-id="a"]')!.dataset.flying).toBeUndefined();
  });

  it("查看中换过图：缩回换后的那张", async () => {
    render(<Harness />);
    await openSettled("open-a");
    press("open-b");
    press("close");
    expect(flier()!.style.left).toBe("200px");
    expect(flier()!.style.top).toBe("300px");
    expect(document.querySelector<HTMLElement>('.card[data-id="b"]')!.dataset.flying).toBe("");
    expect(document.querySelector<HTMLElement>('.card[data-id="a"]')!.dataset.flying).toBeUndefined();
  });

  it("飞到一半按返回：同一个飞行元素掉头", () => {
    render(<Harness />);
    press("open-a");
    const flying = flier();
    press("close");
    expect(flier()).toBe(flying);
    expect(viewer()!.dataset.flight).toBe("land");
  });

  it("捕获等要求立刻看到图片墙时不播过渡", async () => {
    const { rerender } = render(<Harness />);
    await openSettled("open-a");
    rerender(<Harness instant />);
    press("close");
    expect(viewer()).toBeNull();
    expect(flier()).toBeNull();
  });
});

describe("墙外的图退回淡入淡出", () => {
  for (const name of ["far", "gone"]) {
    it(`${name}：没有飞行元素，打开淡入、返回淡出`, async () => {
      document.documentElement.style.setProperty("--t", "20ms");
      render(<Harness />);
      press(`open-${name}`);
      expect(flier()).toBeNull();
      expect(viewer()!.dataset.flight).toBe("fade-in");
      expect(original().style.visibility).toBe("hidden");
      await loadOriginal();
      // 淡入不挡原图。
      expect(original().style.visibility).toBe("visible");
      press("close");
      expect(flier()).toBeNull();
      expect(viewer()!.dataset.flight).toBe("fade-out");
      await waitFor(() => expect(viewer()).toBeNull());
    });
  }
});

describe("减弱动效", () => {
  it("开合都直接切换：没有飞行元素，也没有过渡阶段", async () => {
    document.documentElement.setAttribute("data-reduced-motion", "");
    document.documentElement.style.setProperty("--t", "20ms");
    render(<Harness />);
    press("open-a");
    expect(flier()).toBeNull();
    expect(viewer()!.dataset.flight).toBeUndefined();
    await loadOriginal();
    expect(original().style.visibility).toBe("visible");
    press("close");
    expect(viewer()).toBeNull();
  });
});

describe("安全模式", () => {
  it("遮蔽的卡片打开时，飞行全程带遮蔽，只拿缩略图，原图一直隐藏", async () => {
    render(<Harness />);
    press("open-veil");
    expect(flier()!.dataset.veiled).toBe("true");
    expect(flier()!.querySelector("img")!.getAttribute("src")).toBe("thumb://veil");
    expect(original().style.visibility).toBe("hidden");
    // 原图此时已读完，也不能换上来。
    await loadOriginal();
    expect(flier()!.dataset.veiled).toBe("true");
    expect(flier()!.querySelector("img")!.getAttribute("src")).toBe("thumb://veil");
    expect(original().style.visibility).toBe("hidden");
    for (const img of flier()!.querySelectorAll("img")) expect(img.getAttribute("src")).toBe("thumb://veil");
  });

  it("飞向遮蔽的卡片时，即使查看器已读完原图，也只拿缩略图", async () => {
    render(<Harness initial={cards.veil} />);
    await loadOriginal();
    expect(original().style.visibility).toBe("visible");
    press("close");
    expect(flier()!.dataset.veiled).toBe("true");
    expect(flier()!.querySelector("img")!.getAttribute("src")).toBe("thumb://veil");
    expect(original().style.visibility).toBe("hidden");
  });

  it("打开途中开启安全模式：立刻带上遮蔽，到位后也不换原图", async () => {
    const { rerender } = render(<Harness />);
    press("open-r18");
    expect(flier()!.dataset.veiled).toBe("false");
    rerender(<Harness safe />);
    expect(flier()!.dataset.veiled).toBe("true");
    await loadOriginal();
    await waitFor(() => expect(viewer()!.dataset.flight).toBeUndefined(), LANDED);
    expect(flier()!.dataset.veiled).toBe("true");
    expect(original().style.visibility).toBe("hidden");
  });

  it("安全模式关掉查看器时不飞也不淡，这一帧就消失", async () => {
    document.documentElement.style.setProperty("--t", "20ms");
    const { rerender } = render(<Harness initial={cards.r18} />);
    await loadOriginal();
    rerender(<Harness initial={cards.r18} safe />);
    // 查看器还没收到关闭时，原图也已经藏起来。
    expect(original().style.visibility).toBe("hidden");
    press("close");
    expect(viewer()).toBeNull();
    expect(flier()).toBeNull();
  });

  it("飞回途中开启安全模式：立刻收掉，不把原图带着飞完", async () => {
    const { rerender } = render(<Harness initial={cards.r18} />);
    await loadOriginal();
    press("close");
    expect(flier()).not.toBeNull();
    rerender(<Harness initial={cards.r18} safe />);
    expect(flier()).toBeNull();
    expect(viewer()).toBeNull();
  });

  it("墙外的成人图淡出途中开启安全模式：同样立刻收掉", () => {
    document.documentElement.style.setProperty("--t", "2000ms");
    const { rerender } = render(<Harness initial={makeCard("gone", true)} />);
    press("close");
    expect(viewer()!.dataset.flight).toBe("fade-out");
    rerender(<Harness safe />);
    expect(viewer()).toBeNull();
  });
});
