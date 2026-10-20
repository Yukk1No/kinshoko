import { describe, expect, it, vi } from "vitest";
import { PinKeys } from "./pinKeys";

// 一个钉图层里多个钉图时，快捷键归谁（#193）。
describe("钉图层的快捷键", () => {
  const key = (k: string, ctrlKey = false) => new KeyboardEvent("keydown", { key: k, ctrlKey, cancelable: true });

  it("只有一个钉图时就是它", () => {
    const keys = new PinKeys();
    const a = vi.fn();
    keys.register("A", a);
    keys.dispatch(key("h"));
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("光标下的钉图优先，其次是最近按过的；两样都没有时谁也不收", () => {
    const keys = new PinKeys();
    const a = vi.fn();
    const b = vi.fn();
    keys.register("A", a);
    keys.register("B", b);
    keys.dispatch(key("h"));
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    keys.press("A");
    keys.dispatch(key("h"));
    expect(a).toHaveBeenCalledTimes(1);
    keys.enter("B");
    keys.dispatch(key("h"));
    expect(b).toHaveBeenCalledTimes(1);
    keys.leave("B");
    keys.dispatch(key("h"));
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("关掉的钉图不再收按键", () => {
    const keys = new PinKeys();
    const a = vi.fn();
    const b = vi.fn();
    const stopA = keys.register("A", a);
    keys.register("B", b);
    keys.enter("A");
    stopA();
    keys.dispatch(key("Escape"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("Ctrl 加减号不让 WebView 缩放页面，也不交给钉图", () => {
    const keys = new PinKeys();
    const a = vi.fn();
    keys.register("A", a);
    const e = key("=", true);
    keys.dispatch(e);
    expect(e.defaultPrevented).toBe(true);
    expect(a).not.toHaveBeenCalled();
  });
});
