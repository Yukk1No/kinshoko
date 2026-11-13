import { describe, expect, it } from "vitest";
import { invoke } from "../ipc/invoke";
import { CommandFailure } from "../ipc/commandError";
import { shellSettings as readShellSettings } from "../ipc";
import { fakeBackend, shellSettings } from "./backend";

describe("fakeBackend", () => {
  it("rejects a command nobody answered and names it", async () => {
    fakeBackend();
    await expect(invoke("plugin:library|browse", { libraryId: "L1" })).rejects.toThrow("fake backend: no reply for browse");
  });

  it("answers shell_settings, safe_mode and workspace_status by default", async () => {
    fakeBackend();
    await expect(readShellSettings()).resolves.toEqual(shellSettings());
    await expect(invoke("plugin:library|safe_mode")).resolves.toBe(true);
    await expect(invoke("plugin:library|workspace_status", { safeMode: true })).resolves.toEqual({ revision: "r1", libraries: [] });
  });

  it("lets on() and the initial replies replace a default", async () => {
    const backend = fakeBackend({ safe_mode: false });
    await expect(invoke("plugin:library|safe_mode")).resolves.toBe(false);
    backend.on("shell_settings", shellSettings({ runLog: true }));
    await expect(readShellSettings()).resolves.toMatchObject({ runLog: true });
  });

  it("passes the arguments to a reply function and waits for its promise", async () => {
    fakeBackend({ echo: async (args) => args.text });
    await expect(invoke("echo", { text: "你好" })).resolves.toBe("你好");
  });

  it("turns a rejected reply into a CommandFailure through the real invoke", async () => {
    fakeBackend({ image: () => Promise.reject({ code: "unknownImage" }) });
    const failure = await invoke("plugin:library|image", { imageId: "a" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailure);
    expect(failure).toMatchObject({ code: "unknownImage" });
  });

  it("recognises a command with or without its plugin prefix", async () => {
    const backend = fakeBackend({ "plugin:desktop|gate_pins": 1, sidebar: 2 });
    await expect(invoke("gate_pins")).resolves.toBe(1);
    await expect(invoke("plugin:library|sidebar")).resolves.toBe(2);
    expect(backend.calls("plugin:library|sidebar")).toEqual([{ command: "sidebar", args: {} }]);
    expect(backend.calls("gate_pins")).toHaveLength(1);
  });

  it("records calls in order, filtered by command when asked", async () => {
    const backend = fakeBackend({ a: null, b: null });
    await invoke("a", { n: 1 });
    await invoke("plugin:library|b", { n: 2 });
    await invoke("a", { n: 3 });
    await invoke("missing").catch(() => {});
    expect(backend.calls().map((call) => call.command)).toEqual(["a", "b", "a", "missing"]);
    expect(backend.calls("a").map((call) => call.args)).toEqual([{ n: 1 }, { n: 3 }]);
  });
});
