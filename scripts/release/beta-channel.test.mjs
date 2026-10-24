import { describe, expect, it } from "vitest";
import { compareVersions, planBetaChannel } from "./beta-channel.mjs";

const repo = "Yukk1No/kinshoko";
const manifest = (version, tag = `v${version}`) => {
  const platform = { signature: "sig", url: `https://github.com/${repo}/releases/download/${tag}/Kinshoko_${version}_x64-setup.exe` };
  return { version, notes: "", pub_date: "2026-10-20T00:00:00Z", platforms: { "windows-x86_64-nsis": platform, "windows-x86_64": platform } };
};

describe("SemVer 比较", () => {
  it("测试版、候选版低于同号正式版，编号按数字比", () => {
    const ordered = ["0.1.0", "1.0.0-beta.1", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0-beta.1"];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i - 1], ordered[i])).toBeLessThan(0);
      expect(compareVersions(ordered[i], ordered[i - 1])).toBeGreaterThan(0);
    }
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });
});

describe("测试版通道的 latest.json", () => {
  it("通道还没有清单时，发布的测试版成为通道版本", () => {
    expect(planBetaChannel({ tag: "v1.0.0-beta.1", published: manifest("1.0.0-beta.1"), prerelease: true, current: null, repo }))
      .toEqual({ update: true, version: "1.0.0-beta.1", reason: "测试版通道还没有 latest.json，写入 1.0.0-beta.1。" });
  });

  it("测试版、候选版、正式版比通道里的新时都更新通道", () => {
    for (const [from, to] of [["1.0.0-beta.1", "1.0.0-beta.2"], ["1.0.0-beta.2", "1.0.0-rc.1"], ["1.0.0-rc.1", "1.0.0"], ["1.0.0", "1.0.1"]]) {
      expect(planBetaChannel({ tag: `v${to}`, published: manifest(to), prerelease: to.includes("-"), current: manifest(from), repo }).update).toBe(true);
    }
  });

  it("重新运行同一版本时照样覆盖", () => {
    expect(planBetaChannel({ tag: "v1.0.0", published: manifest("1.0.0"), prerelease: false, current: manifest("1.0.0"), repo }).update).toBe(true);
  });

  it("发布的版本比通道里的旧时不动通道（例如测试 1.1.0-beta.1 期间补发 1.0.1）", () => {
    const plan = planBetaChannel({ tag: "v1.0.1", published: manifest("1.0.1"), prerelease: false, current: manifest("1.1.0-beta.1"), repo });
    expect(plan.update).toBe(false);
    expect(plan.reason).toContain("1.1.0-beta.1");
  });

  it("清单的版本与标签不一致、或安装包不在原仓库这个版本的 Release 里时报错", () => {
    expect(() => planBetaChannel({ tag: "v1.0.0-beta.2", published: manifest("1.0.0-beta.1"), prerelease: true, current: null, repo }))
      .toThrow("标签 v1.0.0-beta.2");
    const foreign = manifest("1.0.0-beta.1");
    foreign.platforms["windows-x86_64"] = { signature: "sig", url: "https://example.com/Kinshoko.exe" };
    expect(() => planBetaChannel({ tag: "v1.0.0-beta.1", published: foreign, prerelease: true, current: null, repo }))
      .toThrow("windows-x86_64");
    const unsigned = manifest("1.0.0-beta.1");
    unsigned.platforms["windows-x86_64-nsis"].signature = "";
    expect(() => planBetaChannel({ tag: "v1.0.0-beta.1", published: unsigned, prerelease: true, current: null, repo }))
      .toThrow("签名");
  });

  it("测试版、候选版没有标为预发布，或正式版标成了预发布时报错：它会进错正式版通道", () => {
    expect(() => planBetaChannel({ tag: "v1.1.0-beta.1", published: manifest("1.1.0-beta.1"), prerelease: false, current: null, repo }))
      .toThrow("预发布");
    expect(() => planBetaChannel({ tag: "v1.0.0", published: manifest("1.0.0"), prerelease: true, current: null, repo }))
      .toThrow("预发布");
  });

  it("通道 Release 自己的发布事件不处理", () => {
    expect(planBetaChannel({ tag: "channel-beta", published: null, current: null, repo }))
      .toEqual({ update: false, reason: "channel-beta 是测试版通道本身，不处理。" });
  });
});
