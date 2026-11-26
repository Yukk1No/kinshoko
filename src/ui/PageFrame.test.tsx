import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaCardFrame } from "./MediaCardFrame";
import { PageFrame, PageSubbar, PageSurface, PageTopbar } from "./PageFrame";

describe("PageFrame", () => {
  it("给出侧栏插槽、顶栏、次栏与工作面的骨架结构", () => {
    const { container } = render(
      <PageFrame sidebar={<nav>侧栏</nav>} endbar={<aside>详情</aside>}>
        <PageTopbar>顶栏</PageTopbar>
        <PageSubbar>次栏</PageSubbar>
        <PageSurface>工作面</PageSurface>
      </PageFrame>,
    );
    const frame = container.firstElementChild!;
    expect(frame.className).toContain("k-page-frame");
    expect(frame.querySelector(":scope > nav")?.textContent).toBe("侧栏");
    expect(frame.querySelector(":scope > aside")?.textContent).toBe("详情");
    const body = frame.querySelector(":scope > .k-page-body")!;
    expect(body.querySelector(":scope > .k-page-topbar")?.tagName).toBe("HEADER");
    expect(body.querySelector(":scope > .k-page-subbar")?.textContent).toBe("次栏");
    expect(body.querySelector(":scope > .k-page-surface")?.textContent).toBe("工作面");
  });

  it("没有次栏时不渲染 48 px 次栏", () => {
    const { container } = render(
      <PageFrame>
        <PageTopbar>顶栏</PageTopbar>
        <PageSurface>工作面</PageSurface>
      </PageFrame>,
    );
    expect(container.querySelector(".k-page-subbar")).toBeNull();
  });
});

describe("MediaCardFrame", () => {
  it("暴露选中态与四角槽位，媒体操作在内容层里", () => {
    const { container } = render(
      <MediaCardFrame
        selected
        corners={{
          topStart: <span>页数</span>,
          bottomEnd: <button type="button">收藏</button>,
        }}
      >
        <button type="button" className="k-media-card-open">
          打开
        </button>
      </MediaCardFrame>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("k-media-card");
    expect(card.getAttribute("data-selected")).toBe("true");
    expect(card.querySelector(".k-media-card-content > .k-media-card-open")?.textContent).toBe("打开");
    expect(card.querySelector(".k-media-corner.is-topStart")?.textContent).toBe("页数");
    expect(card.querySelector(".k-media-corner.is-bottomEnd")?.textContent).toBe("收藏");
  });

  it("叠纸卡片把纸层放在内容层后面，悬停微抬只作用于封面", () => {
    const { container } = render(
      <MediaCardFrame stacked layers={<i aria-hidden="true" />}>
        图
      </MediaCardFrame>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("is-stack");
    expect(card.firstElementChild?.tagName).toBe("I");
    expect(card.children[1].className).toContain("k-media-card-content");
  });
});
