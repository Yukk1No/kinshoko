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

describe.each(["prepare", "tag"])("%s 的分支规则", (step) => {
  it("main 上发任何版本", () => {
    for (const version of ["1.1.0-beta.1", "1.1.0-rc.1", "1.1.0", "1.0.1", "2.0.0"]) {
      expect(releaseProblem({ step, version, branch: "main" })).toBeNull();
    }
  });

  it("维护分支只发同一主次版本号", () => {
    expect(releaseProblem({ step, version: "1.0.1", branch: "maint/1.0" })).toBeNull();
    expect(releaseProblem({ step, version: "1.0.2-rc.1", branch: "maint/1.0" })).toBeNull();
    expect(releaseProblem({ step, version: "1.1.0", branch: "maint/1.0" })).toMatch(/只发 1\.0\.x/);
    expect(releaseProblem({ step, version: "2.0.1", branch: "maint/1.0" })).toMatch(/只发 1\.0\.x/);
  });

  it("其他分支不发", () => {
    for (const branch of ["integration/v1", "claude/feature", "maint/1", "maint/1.0.x", "release/v1.1.0"]) {
      expect(releaseProblem({ step, version: "1.1.0", branch })).toMatch(/main 或维护分支/);
    }
  });
});

describe("共同规则", () => {
  it.each(["v1.0.0", "1.0", "1.0.0-beta", "1.0.0-rc.0", "1.0.0-dev.1", "01.0.0"])("拒绝格式不对的 %s", (version) => {
    expect(releaseProblem({ step: "prepare", version, branch: "main" })).toMatch(/格式/);
  });

  it.each(["prepare", "tag"])("%s 时给了当前版本，新版本必须更大", (step) => {
    const branch = "main";
    expect(releaseProblem({ step, version: "1.1.0-beta.1", branch, current: "1.0.0" })).toBeNull();
    expect(releaseProblem({ step, version: "1.1.0-beta.1", branch, current: "1.1.0-beta.1" })).toMatch(/不大于/);
    expect(releaseProblem({ step, version: "1.1.0-beta.1", branch, current: "2.0.0-beta.1" })).toMatch(/不大于/);
  });

  it("当前版本读不出时不比较", () => {
    expect(releaseProblem({ step: "tag", version: "1.1.0-beta.1", branch: "main", current: "" })).toBeNull();
  });
});
