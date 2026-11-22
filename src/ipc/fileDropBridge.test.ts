import { afterEach, beforeEach, expect, it, vi } from "vitest";
import bridge from "../../src-tauri/src/file_drop.js?raw";

let frame: HTMLIFrameElement;
let page: Window & typeof globalThis;

beforeEach(() => {
  frame = document.createElement("iframe");
  document.body.append(frame);
  page = frame.contentWindow as Window & typeof globalThis;
});

afterEach(() => {
  frame.remove();
  vi.restoreAllMocks();
});

const initialize = (origin = page.location.origin) =>
  page.eval(
    bridge
      .replace('"__KINSHOKO_APP_ORIGIN__"', JSON.stringify(origin))
      .replace('"__KINSHOKO_INVOKE_KEY__"', '"test-key"'),
  );

const drag = (type: string, types?: string[]) => {
  const event = new page.Event(type, { bubbles: true, cancelable: true });
  if (types) Object.defineProperty(event, "dataTransfer", { value: { types } });
  page.document.body.dispatchEvent(event);
  return event;
};

it.each(["dragover", "drop"])("启动时就阻止 Files 默认导航，但 %s 仍传到后续监听", (type) => {
  initialize();
  const later = vi.fn((event: Event) => expect(event.defaultPrevented).toBe(true));
  page.document.body.addEventListener(type, later);

  expect(drag(type, ["Files"]).defaultPrevented).toBe(true);
  expect(later).toHaveBeenCalledTimes(1);
});

it.each(["dragover", "drop"])("不阻止文本、内部图片或文件夹的 %s", (type) => {
  initialize();
  const later = vi.fn();
  page.document.body.addEventListener(type, later);
  for (const types of [
    undefined,
    [],
    ["text/plain"],
    ["application/x-kinshoko-images"],
    ["application/x-kinshoko-folder"],
  ]) {
    expect(drag(type, types).defaultPrevented).toBe(false);
  }
  expect(later).toHaveBeenCalledTimes(5);
});

it("其他来源不安装窗口监听", () => {
  const add = vi.spyOn(page, "addEventListener");
  initialize("https://other.example");
  expect(add).not.toHaveBeenCalled();
  for (const type of ["dragover", "drop"]) {
    expect(drag(type, ["Files"]).defaultPrevented).toBe(false);
  }
});
