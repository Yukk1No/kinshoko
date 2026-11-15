import { describe, expect, it } from "vitest";
import { findProblems, frontendCalls, registeredCommands } from "./check-command-names.mjs";

const registered = { app: ["app_info"], library: ["list_images"], desktop: ["start_capture"] };
const noExceptions = { app: {}, library: {}, desktop: {} };
const problems = (calls, exceptions = noExceptions) => findProblems({ registered, calls, exceptions });
const allUsed = [
  { group: "app", name: "app_info", file: "a.ts", line: 1 },
  { group: "library", name: "list_images", file: "a.ts", line: 2 },
  { group: "desktop", name: "start_capture", file: "a.ts", line: 3 },
];

describe("Rust 一侧", () => {
  it("去掉模块路径和注释", () => {
    const source = "x.invoke_handler(tauri::generate_handler![\n  commands::app_info, // 说明\n  a::b::c,\n]);";
    expect(registeredCommands(source)).toEqual(["app_info", "c"]);
  });
});

describe("前端一侧", () => {
  it("按组归类，跨行的调用也算，注释里的不算", () => {
    const source = `
      invoke<void>("app_info");
      invoke<import("../x").X>(
        lib("list_images"),
        { id },
      );
      invoke(
        desk("start_capture"));
      // invoke("in_comment");
    `;
    expect(frontendCalls(source).map((c) => [c.group, c.name])).toEqual([
      ["library", "list_images"],
      ["desktop", "start_capture"],
      ["app", "app_info"],
    ]);
  });

  it("名字里带空格等符号也要抓到，不能漏掉", () => {
    expect(frontendCalls('invoke("log_frontend ", {}); lib("a-b")').map((c) => c.name)).toEqual([
      "a-b",
      "log_frontend ",
    ]);
  });

  it("带行号", () => {
    expect(frontendCalls('\n\nlib(\n"x")')[0].line).toBe(3);
  });
});

describe("核对", () => {
  it("全部对得上时没有问题", () => {
    expect(problems(allUsed)).toEqual([]);
  });

  it("前端写错的名字：指出名字、组与位置", () => {
    const [problem] = problems([...allUsed, { group: "library", name: "list_imges", file: "src/b.ts", line: 9 }]);
    expect(problem).toContain("src/b.ts:9");
    expect(problem).toContain("list_imges");
    expect(problem).toContain("library");
  });

  it("名字注册在别的组里也算写错", () => {
    const calls = allUsed.map((c) => (c.name === "list_images" ? { ...c, group: "app" } : c));
    expect(problems(calls).length).toBeGreaterThan(0);
  });

  it("注册了却没人用的命令失败，写进例外表后通过", () => {
    const calls = allUsed.filter((c) => c.group !== "desktop");
    expect(problems(calls)[0]).toContain("start_capture");
    expect(problems(calls, { ...noExceptions, desktop: { start_capture: "仅 e2e 使用" } })).toEqual([]);
  });

  it("过期的例外条目失败：命令已删除，或前端已在用", () => {
    expect(problems(allUsed, { ...noExceptions, app: { gone: "x" } })[0]).toContain("gone");
    expect(problems(allUsed, { ...noExceptions, app: { app_info: "x" } })[0]).toContain("app_info");
  });
});
