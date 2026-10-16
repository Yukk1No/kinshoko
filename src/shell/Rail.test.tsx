import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { Rail } from "./Rail";
import { sealBookSVG } from "./sealbook";

function backend(groups: unknown[], captures: unknown[]) {
  mockWindows("main");
  mockIPC((cmd) => {
    if (cmd === "plugin:desktop|reference_groups") return groups;
    if (cmd === "plugin:desktop|capture_history") return captures;
    return null;
  }, { shouldMockEvents: true });
}

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

/** 与 innerHTML 同样序列化，便于比较。 */
const drawn = (markup: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.innerHTML = markup;
  return svg.innerHTML;
};

const rail = (safeMode: boolean) => render(<Rail section="browse" paneOpen safeMode={safeMode}
  onSection={() => {}} onSafeMode={() => {}} onSettings={() => {}} />);

describe("图标轨", () => {
  it("封印书画的是原型的第五轮 A1 圆锁（合上为开启，翻开为关闭）", () => {
    backend([], []);
    rail(true);
    const sealed = screen.getByRole("button", { name: "安全模式：开启" });
    expect(sealed.getAttribute("aria-pressed")).toBe("true");
    expect(sealed.querySelector("svg")!.innerHTML).toBe(drawn(sealBookSVG(0)));
    cleanup();
    rail(false);
    const open = screen.getByRole("button", { name: "安全模式：关闭" });
    expect(open.querySelector("svg")!.innerHTML).toBe(drawn(sealBookSVG(1)));
  });

  it("参考组与截图显示深色数字角标，没有时不显示", async () => {
    backend([{ id: "g1" }, { id: "g2" }], [{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
    rail(false);
    await waitFor(() => expect(within(screen.getByRole("button", { name: "参考组" })).getByText("2")).toBeTruthy());
    expect(within(screen.getByRole("button", { name: "截图历史" })).getByText("3").className).toContain("rail-badge");
    expect(screen.getByRole("button", { name: "图片与文件夹" }).querySelector(".rail-badge")).toBeNull();
  });

  it("选中项只用 aria-current 与 aria-expanded，不同时声明 aria-pressed", () => {
    backend([], []);
    rail(false);
    const current = screen.getByRole("button", { name: "图片与文件夹" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.getAttribute("aria-expanded")).toBe("true");
    expect(current.hasAttribute("aria-pressed")).toBe(false);
  });

  it("图标用 lucide 原图标", () => {
    backend([], []);
    rail(false);
    expect(screen.getByRole("button", { name: "参考组" }).querySelector("svg.lucide-layers")).not.toBeNull();
    expect(screen.getByRole("button", { name: "设置" }).querySelector("svg.lucide-settings")).not.toBeNull();
  });
});
