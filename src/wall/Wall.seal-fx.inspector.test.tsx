// #27：安全模式切换时详情面板收起、图片墙变宽，封印／释放动画照常。
import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { SEAL } from "../shell/sealfx";
import { resize } from "../test/platform";
import { Wall } from "./Wall";
import {
  answer,
  base,
  card,
  frames,
  ghosts,
  installSealFx,
  node,
  recordAnimations,
  wallWith,
  type FxPage,
} from "./Wall.seal-fx.fixtures";

installSealFx();

describe("切换时详情面板随选择清空而收起，图片墙变宽", () => {
  const widen = () =>
    act(() => {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1320 });
      resize(document.querySelector(".wall")!);
    });

  it("关闭：墙先变宽、资料库后送回成人图，影子照样从书里飞回", async () => {
    const view = await wallWith(true, { cards: [card("g")], total: 1, nextCursor: null });
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    await widen();
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    expect(ghosts()).toBe(1);
    expect(node("a").classList.contains("is-arriving")).toBe(true);
  });

  it("开启：变宽按平常的 200 ms 重排，飞走的图让位仍按封印的节奏（620 ms）", async () => {
    const view = await wallWith(false);
    const glides = recordAnimations();
    view.rerender(<Wall {...base} reloadKey={1} safeMode />);
    await widen();
    const widened = glides.filter((x) => x.id === "g");
    expect(widened.at(-1)?.timing).toMatchObject({ duration: 200 });
    const mid = node("g").getBoundingClientRect();
    await frames(SEAL.flyAt + 20 + 16);
    expect(node("a")).toBeNull();
    const slide = glides.filter((x) => x.id === "g").at(-1)!;
    expect(slide.timing).toMatchObject({ duration: 620 });
    // 让位从变宽后的位置起滑，不先跳回变宽之前的位置。
    const end = node("g").getBoundingClientRect();
    expect(slide.keyframes[0]?.transform).toBe(
      `translate(${mid.left - end.left}px, ${mid.top - end.top}px) scale(${mid.width / end.width}, ${mid.height / end.height})`,
    );
  });

  it("关闭后送回的页面没有成人图：这次释放就此结束，之后别的浏览带来的成人图不从书里飞出", async () => {
    const plain: FxPage = { cards: [card("g")], total: 1, nextCursor: null };
    const view = await wallWith(true, plain);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer(plain);
    expect(ghosts()).toBe(0);
    // 1.5 s 内另一次浏览（换了条件、导入等）送回了成人图：不是这次释放的一部分。
    view.rerender(<Wall {...base} reloadKey={2} safeMode={false} />);
    await answer();
    expect(ghosts()).toBe(0);
    expect(node("a").classList.contains("is-arriving")).toBe(false);
  });
});
