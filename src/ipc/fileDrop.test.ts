import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { onFileDrop } from "../ipc";
import bridge from "../../src-tauri/src/file_drop.js?raw";

const { listen, unlisten, post } = vi.hoisted(() => ({ listen: vi.fn(), unlisten: vi.fn(), post: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ listen }) }));

let stop: (() => void) | undefined;
const handler = vi.fn();
const transformCallback = vi.fn(() => 42);
const unregisterCallback = vi.fn();
const initialize = (origin = location.origin) =>
  window.eval(
    bridge
      .replace('"__KINSHOKO_APP_ORIGIN__"', JSON.stringify(origin))
      .replace('"__KINSHOKO_INVOKE_KEY__"', '"test-key"'),
  );
const files = [new File(["image"], "image.png"), new File([], "folder")];
const transfer = { types: ["Files"], files };
const drag = (type: string, dataTransfer: object = transfer) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  window.dispatchEvent(event);
  return event;
};

beforeEach(async () => {
  vi.clearAllMocks();
  listen.mockResolvedValue(unlisten);
  vi.stubGlobal("chrome", { webview: { postMessageWithAdditionalObjects: post } });
  vi.stubGlobal("__TAURI_INTERNALS__", { transformCallback, unregisterCallback });
  vi.stubGlobal("__KINSHOKO_FILE_DROP__", undefined);
  initialize();
  stop = await onFileDrop(handler);
});
afterEach(() => {
  stop?.();
  vi.unstubAllGlobals();
});

it("只接受 Files：内部图片、文件夹与普通文本拖动不阻止也不显示导入提示", () => {
  for (const types of [[], ["text/plain"], ["application/x-kinshoko-images"], ["application/x-kinshoko-folder"]]) {
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
      expect(drag(type, { types, files }).defaultPrevented).toBe(false);
    }
  }
  expect(handler).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it("文件进入子元素不闪烁，最后离开才关闭提示，重复离开不让计数变负数", () => {
  expect(drag("dragenter").defaultPrevented).toBe(true);
  drag("dragenter");
  expect(drag("dragover").defaultPrevented).toBe(true);
  drag("dragleave");
  expect(handler.mock.calls).toEqual([[{ kind: "enter", paths: [] }]]);
  drag("dragleave");
  drag("dragleave");
  expect(handler.mock.calls).toEqual([[{ kind: "enter", paths: [] }], [{ kind: "leave" }]]);
  drag("dragenter");
  expect(handler).toHaveBeenLastCalledWith({ kind: "enter", paths: [] });
});

it("放下时清理嵌套状态并原样发送对象标记与 FileList，收到本窗口的路径才导入", () => {
  drag("dragenter");
  drag("dragenter");
  expect(drag("drop").defaultPrevented).toBe(true);
  expect(handler).toHaveBeenLastCalledWith({ kind: "leave" });
  expect(JSON.parse(post.mock.calls[0][0])).toEqual({
    cmd: "file_drop_ack",
    callback: 42,
    error: 42,
    payload: { kind: "kinshoko-file-drop", version: 1 },
    __TAURI_INVOKE_KEY__: "test-key",
  });
  expect(typeof post.mock.calls[0][0]).toBe("string");
  expect(transformCallback).toHaveBeenCalledWith(expect.any(Function), true);
  expect(post.mock.calls[0][1]).toBe(files);
  expect(listen).toHaveBeenCalledWith("kinshoko-file-drop", expect.any(Function));
  listen.mock.calls[0][1]({ payload: ["D:\\image.png", "D:\\folder"] });
  expect(handler).toHaveBeenLastCalledWith({ kind: "drop", paths: ["D:\\image.png", "D:\\folder"] });
  drag("dragenter");
  expect(handler).toHaveBeenLastCalledWith({ kind: "enter", paths: [] });
});

it("空文件拖放只清理提示，不发送桥接消息", () => {
  drag("dragenter");
  drag("drop", { types: ["Files"], files: [] });
  expect(handler).toHaveBeenLastCalledWith({ kind: "leave" });
  expect(post).not.toHaveBeenCalled();
});

it("桥接不向外部来源暴露发送入口，也不把调用密钥写进函数体", () => {
  const send = Reflect.get(window, "__KINSHOKO_FILE_DROP__");
  expect(send.toString()).not.toContain("test-key");
  Reflect.set(window, "__KINSHOKO_FILE_DROP__", undefined);
  initialize("https://other.example");
  expect(Reflect.get(window, "__KINSHOKO_FILE_DROP__")).toBeUndefined();
});

it("桥接发送失败时释放确认回调", () => {
  post.mockImplementationOnce(() => {
    throw new Error("bridge failed");
  });
  expect(() => Reflect.get(window, "__KINSHOKO_FILE_DROP__")(files)).toThrow("bridge failed");
  expect(unregisterCallback).toHaveBeenCalledWith(42);
});

it.each(["dragend", "Escape", "drop"])("取消或内部放下也清理提示：%s", (cancel) => {
  drag("dragenter");
  drag("dragenter");
  if (cancel === "Escape") fireEvent.keyDown(window, { key: "Escape" });
  else if (cancel === "drop") drag("drop", { types: ["application/x-kinshoko-images"] });
  else window.dispatchEvent(new Event("dragend"));
  expect(handler).toHaveBeenLastCalledWith({ kind: "leave" });
  drag("dragleave");
  drag("dragenter");
  expect(handler).toHaveBeenLastCalledWith({ kind: "enter", paths: [] });
  expect(post).not.toHaveBeenCalled();
});

it("取消订阅会移除窗口监听与原生路径监听", () => {
  stop?.();
  stop = undefined;
  drag("dragenter");
  drag("drop");
  expect(handler).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  expect(unlisten).toHaveBeenCalledTimes(1);
});
