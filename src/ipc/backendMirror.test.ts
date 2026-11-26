import { describe, expect, it, vi } from "vitest";
import { invoke } from "./invoke";
import { isErrorCode } from "./commandError";
import { createBackendMirror } from "./backendMirror";
import { fakeBackend } from "../test/backend";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const stale = (error: unknown) => isErrorCode(error, "cursorExpired");

describe("createBackendMirror", () => {
  it("按查询键分别缓存，后开始的读取回来后不被先开始的旧读取盖掉", async () => {
    const pending: { key: string; resolve: (value: string) => void }[] = [];
    const backend = fakeBackend({
      read: (args) =>
        new Promise<string>((resolve) => {
          pending.push({ key: args.key as string, resolve });
        }),
    });
    const mirror = createBackendMirror({ read: (key: string) => invoke<string>("read", { key }) });
    mirror.subscribe("safe", () => {});
    mirror.subscribe("all", () => {});
    await flush();
    expect(backend.calls("read").map((call) => call.args.key)).toEqual(["safe", "all"]);

    mirror.invalidate("safe");
    await flush();
    expect(backend.calls("read")).toHaveLength(3);
    pending[2].resolve("safe-new");
    await flush();
    expect(mirror.snapshot("safe").value).toBe("safe-new");
    pending[0].resolve("safe-old");
    await flush();
    expect(mirror.snapshot("safe").value).toBe("safe-new");

    pending[1].resolve("all-value");
    await flush();
    expect(mirror.snapshot("all").value).toBe("all-value");
  });

  it("读取过期时重试，重读成功后接受新值", async () => {
    let calls = 0;
    fakeBackend({
      read: () => {
        calls++;
        return calls < 3 ? Promise.reject({ code: "cursorExpired" }) : "fresh";
      },
    });
    const mirror = createBackendMirror({
      read: () => invoke<string>("read"),
      stale,
      wait: () => Promise.resolve(),
    });
    mirror.subscribe("lens", () => {});
    await vi.waitFor(() => expect(calls).toBe(3));
    await vi.waitFor(() => expect(mirror.snapshot("lens").value).toBe("fresh"));
    expect(mirror.snapshot("lens").error).toBeNull();
  });

  it("读取一直过期时最多重试三次，然后交出错误", async () => {
    let calls = 0;
    fakeBackend({
      read: () => {
        calls++;
        return Promise.reject({ code: "cursorExpired" });
      },
    });
    const mirror = createBackendMirror({
      read: () => invoke<string>("read"),
      stale,
      wait: () => Promise.resolve(),
    });
    mirror.subscribe("lens", () => {});
    await vi.waitFor(() => expect(calls).toBe(4));
    await vi.waitFor(() => expect(mirror.snapshot("lens").error).toMatchObject({ code: "cursorExpired" }));
  });

  it("最后一个订阅者退订后，等待重试的令牌作废，不再发新的读取", async () => {
    let calls = 0;
    let releaseWait: (() => void) | null = null;
    fakeBackend({
      read: () => {
        calls++;
        return Promise.reject({ code: "cursorExpired" });
      },
    });
    const mirror = createBackendMirror({
      read: () => invoke<string>("read"),
      stale,
      wait: () =>
        new Promise((resolve) => {
          releaseWait = resolve;
        }),
    });
    const stop = mirror.subscribe("lens", () => {});
    await vi.waitFor(() => expect(releaseWait).not.toBeNull());
    stop();
    releaseWait!();
    await flush();
    expect(calls).toBe(1);
    expect(mirror.snapshot("lens").value).toBeNull();
  });

  it("事件让对应查询键重读；最后一个订阅者离开后取消事件订阅", async () => {
    let value = "first";
    let event: (() => void) | null = null;
    const unlisten = vi.fn();
    const backend = fakeBackend({ read: () => value });
    const mirror = createBackendMirror({
      read: () => invoke<string>("read"),
      listen: (invalidate) => {
        event = () => invalidate("lens");
        return unlisten;
      },
    });
    const stop = mirror.subscribe("lens", () => {});
    await flush();
    expect(mirror.snapshot("lens").value).toBe("first");
    value = "second";
    event!();
    await flush();
    expect(backend.calls("read")).toHaveLength(2);
    expect(mirror.snapshot("lens").value).toBe("second");
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
