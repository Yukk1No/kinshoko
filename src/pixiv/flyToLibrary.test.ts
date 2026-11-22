import { afterEach, describe, expect, it, vi } from "vitest";

const animate = vi.fn(() => ({ finished: Promise.resolve() }));
vi.mock("motion/react", () => ({ animate }));
const reduced = vi.fn(() => false);
vi.mock("../ui/reducedMotion", () => ({ reducedNow: () => reduced() }));

const { flyToLibrary } = await import("./flyToLibrary");

function box(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
}

function setup({ rail = true } = {}) {
  document.body.innerHTML = `
    <nav class="rail"><button data-section="browse"></button></nav>
    <div class="pw-card"><img src="https://x/y.png" /></div>`;
  if (!rail) document.querySelector(".rail")?.remove();
  const card = document.querySelector(".pw-card") as HTMLElement;
  box(card.querySelector("img") as Element, 200, 100, 120, 160);
  const target = document.querySelector('[data-section="browse"]');
  if (target) box(target, 0, 60, 48, 48);
  return card;
}

afterEach(() => {
  animate.mockClear();
  reduced.mockReturnValue(false);
  document.body.innerHTML = "";
});

describe("收好的图飞向图库图标（#448）", () => {
  it("从卡片的缩略图飞到图标正中，缩小到一小块，飞完拿掉", async () => {
    flyToLibrary(setup());
    const flier = document.querySelector(".fx-layer .pw-flier") as HTMLImageElement;
    expect(flier.src).toBe("https://x/y.png");
    expect(flier.style.left).toBe("200px");
    const [, to] = animate.mock.calls[0] as unknown as [Element, { x: number; y: number; scale: number }];
    // 图中心 (260, 180) → 图标中心 (24, 84)
    expect(to.x).toBe(-236);
    expect(to.y).toBe(-96);
    expect(to.scale).toBeCloseTo(16 / 160);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".fx-layer")).toBeNull();
  });

  it("系统减弱动效时不飞", () => {
    reduced.mockReturnValue(true);
    flyToLibrary(setup());
    expect(document.querySelector(".fx-layer")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("没有图标轨或起点已不在页面上时不飞", () => {
    flyToLibrary(setup({ rail: false }));
    flyToLibrary(null);
    expect(animate).not.toHaveBeenCalled();
  });
});
