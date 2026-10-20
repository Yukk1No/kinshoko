import { describe, expect, it } from "vitest";
import { compareVersions, releaseProblem } from "./release-version.mjs";

describe("版本号比较（SemVer）", () => {
  it.each([
    ["1.0.0-beta.1", "0.1.0"],
    ["1.0.0-beta.2", "1.0.0-beta.1"],
    ["1.0.0-beta.10", "1.0.0-beta.9"],
    ["1.0.0-rc.1", "1.0.0-beta.9"],
    ["1.0.0", "1.0.0-rc.1"],
    ["1.1.0", "1.0.9"],
  ])("%s 大于 %s", (a, b) => {
    expect(compareVersions(a, b)).toBeGreaterThan(0);
    expect(compareVersions(b, a)).toBeLessThan(0);
  });

  it("相同版本相等", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.1")).toBe(0);
  });
});

describe("发布规则", () => {
  it("测试版、候选版从 integration/v1 发，正式版从 main 发", () => {
    expect(releaseProblem({ version: "1.0.0-beta.1", branch: "integration/v1" })).toBeNull();
    expect(releaseProblem({ version: "1.0.0-rc.1", branch: "integration/v1" })).toBeNull();
    expect(releaseProblem({ version: "1.0.0", branch: "main" })).toBeNull();
  });

  it("分支不对时拒绝", () => {
    expect(releaseProblem({ version: "1.0.0", branch: "integration/v1" })).toMatch(/main/);
    expect(releaseProblem({ version: "1.0.0-beta.1", branch: "main" })).toMatch(/integration\/v1/);
    expect(releaseProblem({ version: "1.0.0-beta.1", branch: "claude/feature" })).toMatch(/integration\/v1/);
  });

  it.each(["v1.0.0", "1.0", "1.0.0-beta", "1.0.0-rc.0", "1.0.0-dev.1", "01.0.0"])("拒绝格式不对的 %s", (version) => {
    expect(releaseProblem({ version, branch: "integration/v1" })).toMatch(/格式/);
  });

  it("给了当前版本时，新版本必须更大", () => {
    expect(releaseProblem({ version: "1.0.0-beta.1", branch: "integration/v1", current: "0.1.0" })).toBeNull();
    expect(releaseProblem({ version: "1.0.0-beta.1", branch: "integration/v1", current: "1.0.0-beta.1" })).toMatch(/不大于/);
    expect(releaseProblem({ version: "1.0.0-beta.1", branch: "integration/v1", current: "1.0.0-beta.2" })).toMatch(/不大于/);
  });
});
