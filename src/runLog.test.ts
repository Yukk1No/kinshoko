import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { recordUncaughtErrors } from "./runLog";

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  clearMocks();
});

function backend() {
  const calls: Record<string, unknown>[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "log_frontend") calls.push(args as Record<string, unknown>);
  });
  return calls;
}

it("界面里没有接住的错误与被拒绝的 Promise 记进运行日志", async () => {
  const calls = backend();
  stop = recordUncaughtErrors(window);

  window.dispatchEvent(new ErrorEvent("error", { message: "TypeError: x is undefined", error: new TypeError("x is undefined") }));
  const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
  Object.defineProperty(rejection, "reason", { value: new Error("读取失败") });
  window.dispatchEvent(rejection);
  await Promise.resolve();

  expect(calls).toEqual([
    { level: "error", message: "TypeError: x is undefined" },
    { level: "error", message: "未处理的 Promise 拒绝：读取失败" },
  ]);
});

it("出错循环时每次加载最多记 100 条", async () => {
  const calls = backend();
  stop = recordUncaughtErrors(window);

  for (let i = 0; i < 150; i++) window.dispatchEvent(new ErrorEvent("error", { message: `第 ${i} 次` }));
  await Promise.resolve();

  expect(calls).toHaveLength(100);
});
