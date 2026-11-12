import { afterEach, expect, it } from "vitest";
import { recordUncaughtErrors } from "./runLog";
import { fakeBackend } from "./test/backend";

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

/** 记进运行日志的每一条。 */
function backend() {
  const fake = fakeBackend({ log_frontend: null });
  return () => fake.calls("log_frontend").map((call) => call.args);
}

it("界面里没有接住的错误与被拒绝的 Promise 记进运行日志", async () => {
  const calls = backend();
  stop = recordUncaughtErrors(window);

  window.dispatchEvent(new ErrorEvent("error", { message: "TypeError: x is undefined", error: new TypeError("x is undefined") }));
  const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
  Object.defineProperty(rejection, "reason", { value: new Error("读取失败") });
  window.dispatchEvent(rejection);
  await Promise.resolve();

  expect(calls()).toEqual([
    { level: "error", message: "TypeError: x is undefined" },
    { level: "error", message: "Unhandled promise rejection: 读取失败" },
  ]);
});

it("出错循环时每次加载最多记 100 条", async () => {
  const calls = backend();
  stop = recordUncaughtErrors(window);

  for (let i = 0; i < 150; i++) window.dispatchEvent(new ErrorEvent("error", { message: `第 ${i} 次` }));
  await Promise.resolve();

  expect(calls()).toHaveLength(100);
});
