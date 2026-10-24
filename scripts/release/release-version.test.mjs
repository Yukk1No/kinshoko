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

describe("准备发布（改版本号）", () => {
  it("所有版本都在 integration/v1 上准备，正式版之后经 PR #71 进 main", () => {
    expect(releaseProblem({ step: "prepare", version: "1.0.0-beta.1", branch: "integration/v1" })).toBeNull();
    expect(releaseProblem({ step: "prepare", version: "1.0.0", branch: "integration/v1" })).toBeNull();
  });

  it("不在 integration/v1 上准备", () => {
    expect(releaseProblem({ step: "prepare", version: "1.0.0", branch: "main" })).toMatch(/integration\/v1/);
    expect(releaseProblem({ step: "prepare", version: "1.0.0-beta.1", branch: "claude/feature" })).toMatch(/integration\/v1/);
  });
});

describe("打标签", () => {
  it("测试版、候选版在 integration/v1 上打，正式版在 main 上打", () => {
    expect(releaseProblem({ step: "tag", version: "1.0.0-beta.1", branch: "integration/v1" })).toBeNull();
    expect(releaseProblem({ step: "tag", version: "1.0.0-rc.1", branch: "integration/v1" })).toBeNull();
    expect(releaseProblem({ step: "tag", version: "1.0.0", branch: "main" })).toBeNull();
  });

  it("分支不对时不打", () => {
    expect(releaseProblem({ step: "tag", version: "1.0.0", branch: "integration/v1" })).toMatch(/main/);
    expect(releaseProblem({ step: "tag", version: "1.0.0-beta.1", branch: "main" })).toMatch(/integration\/v1/);
  });
});

describe("共同规则", () => {
  it.each(["v1.0.0", "1.0", "1.0.0-beta", "1.0.0-rc.0", "1.0.0-dev.1", "01.0.0"])("拒绝格式不对的 %s", (version) => {
    expect(releaseProblem({ step: "prepare", version, branch: "integration/v1" })).toMatch(/格式/);
  });

  it.each(["prepare", "tag"])("%s 时给了当前版本，新版本必须更大", (step) => {
    const branch = "integration/v1";
    expect(releaseProblem({ step, version: "1.0.0-beta.1", branch, current: "0.1.0" })).toBeNull();
    expect(releaseProblem({ step, version: "1.0.0-beta.1", branch, current: "1.0.0-beta.1" })).toMatch(/不大于/);
    expect(releaseProblem({ step, version: "1.1.0-beta.1", branch, current: "2.0.0-beta.1" })).toMatch(/不大于/);
  });

  it("当前版本读不出时不比较", () => {
    expect(releaseProblem({ step: "tag", version: "1.0.0-beta.1", branch: "integration/v1", current: "" })).toBeNull();
  });
});
