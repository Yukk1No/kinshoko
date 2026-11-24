import { describe, expect, it } from "vitest";
import { latestJson } from "./latest-json.mjs";

describe("更新清单 latest.json", () => {
  const base = {
    version: "0.2.0",
    signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==\n",
    repo: "Yukk1No/kinshoko",
    installer: "Kinshoko_0.2.0_x64-setup.exe",
    pubDate: "2026-10-07T00:00:00Z",
  };

  it("按 Tauri updater 的静态清单格式写出 NSIS 安装包的地址与签名", () => {
    expect(latestJson(base)).toEqual({
      version: "0.2.0",
      notes: "",
      pub_date: "2026-10-07T00:00:00Z",
      platforms: {
        "windows-x86_64-nsis": {
          signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==",
          url: "https://github.com/Yukk1No/kinshoko/releases/download/v0.2.0/Kinshoko_0.2.0_x64-setup.exe",
        },
        "windows-x86_64": {
          signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==",
          url: "https://github.com/Yukk1No/kinshoko/releases/download/v0.2.0/Kinshoko_0.2.0_x64-setup.exe",
        },
      },
    });
  });

  it("没有签名时拒绝生成，免得发布一个装不上的更新", () => {
    expect(() => latestJson({ ...base, signature: " \n" })).toThrow(/签名为空/);
  });

  it("版本号必须是 semver", () => {
    expect(() => latestJson({ ...base, version: "v0.2" })).toThrow(/semver/);
  });
});
