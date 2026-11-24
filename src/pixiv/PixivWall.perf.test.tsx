import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { PixivWork } from "../bindings/PixivWork";
import { PixivWall, type WallSection } from "./PixivWall";

function makeWork(i: number): PixivWork {
  const id = String(i);
  return {
    id,
    kind: "illustration",
    title: `作品${id}`,
    artist: { userId: "9", name: "画师" },
    tags: ["オリジナル"],
    explicit: false,
    width: 1000,
    height: 1500,
    pages: [
      {
        preview: `https://i.pximg.net/c/540x540_70/img-master/${id}_p0.jpg`,
        large: `https://i.pximg.net/c/600x1200_90/img-master/${id}_p0.jpg`,
        original: `https://i.pximg.net/img-original/${id}_p0.png`,
      },
    ],
    postedAt: 0,
    bookmarked: false,
    followed: false,
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
  };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
});

describe("PixivWall 滚动性能与边沿触发", () => {
  it("同一挂载窗口内滚动不重渲染，近底连续 1px 滚动只触发一次 onNearEnd", () => {
    const sections: WallSection[] = [{ key: "rec", works: Array.from({ length: 48 }, (_, i) => makeWork(i + 1)) }];
    const onNearEnd = vi.fn();
    let renders = 0;

    render(
      <Profiler
        id="pixiv-wall"
        onRender={() => {
          renders += 1;
        }}
      >
        <PixivWall sections={sections} safe={false} onNearEnd={onNearEnd} />
      </Profiler>,
    );

    const wall = document.querySelector<HTMLElement>(".pw-wall")!;
    expect(screen.getByRole("button", { name: "作品1，画师" })).toBeTruthy();
    const rendersAfterMount = renders;
    expect(onNearEnd).toHaveBeenCalledTimes(0);

    // 同一挂载窗口（初始 [-768, 1536)）内小幅连续滚动：零重渲染。
    for (const top of [10, 30, 60, 90, 120]) {
      wall.scrollTop = top;
      fireEvent.scroll(wall);
    }
    expect(renders).toBe(rendersAfterMount);

    // 滚到近底区域（总高度约 4200px，视口 800px，NEAR_END=1200 -> top >= 2200）并做 1px 步进滚动。
    const canvasHeight = parseFloat(document.querySelector<HTMLElement>(".pw-canvas")!.style.height);
    const nearBottom = Math.max(0, canvasHeight - 800 - 200);
    wall.scrollTop = nearBottom;
    fireEvent.scroll(wall);
    expect(renders).toBeGreaterThan(rendersAfterMount);
    expect(onNearEnd).toHaveBeenCalledTimes(1);

    for (let dx = 1; dx <= 5; dx++) {
      wall.scrollTop = nearBottom + dx;
      fireEvent.scroll(wall);
    }
    expect(onNearEnd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "作品48，画师" })).toBeTruthy();
  });
});
