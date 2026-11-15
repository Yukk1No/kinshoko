import { describe, expect, it } from "vitest";
import { evaluate, failureDetail, parseArgs, planSteps } from "./check.mjs";

const stepNames = (argv, env) => planSteps(parseArgs(argv), env).map((step) => step.name);

describe("跑哪些步骤", () => {
  it("默认是 typecheck、命令名对照、biome check 和 vitest", () => {
    expect(stepNames([])).toEqual(["typecheck", "command names", "biome check", "vitest"]);
  });

  it("--rust 加上三步 Rust，--rust-only 只跑这三步", () => {
    const rust = ["cargo fmt", "clippy", "nextest (kinshoko-core)"];
    expect(stepNames(["--rust"])).toEqual(["typecheck", "command names", "biome check", "vitest", ...rust]);
    expect(stepNames(["--rust-only"])).toEqual(rust);
  });

  it("没有 dist 时先构建前端再跑 clippy", () => {
    expect(stepNames(["--rust-only"], { hasDist: false })).toEqual([
      "cargo fmt",
      "vite build (clippy needs dist/)",
      "clippy",
      "nextest (kinshoko-core)",
    ]);
  });

  it("过滤参数原样透传给 vitest 或 nextest，其余步骤不跑", () => {
    const [front] = planSteps(parseArgs(["App.import", "-t", "重复"]));
    expect(front.name).toBe("vitest");
    expect(front.args.slice(-3)).toEqual(["App.import", "-t", "重复"]);

    const [core, ...rest] = planSteps(parseArgs(["--rust-only", "--test", "integration", "tag_catalog::"]));
    expect(core.name).toBe("nextest (kinshoko-core)");
    expect(core.args.slice(-3)).toEqual(["--test", "integration", "tag_catalog::"]);
    expect(rest).toEqual([]);
  });

  it("--rust 同时带过滤参数时拒绝，不猜给谁", () => {
    expect(parseArgs(["--rust", "App.import"]).error).toBeTruthy();
    expect(parseArgs(["--rust", "--rust-only"]).error).toBeTruthy();
  });
});

describe("判定", () => {
  it("用例全过但有未处理错误时，以退出码为准判失败", () => {
    const output = " Test Files  1 passed (1)\n      Tests  3 passed (3)\n     Errors  1 error\n";
    const result = evaluate({ kind: "vitest", status: 1, output });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("3 passed (3), 1 error");
  });

  it("退出码为 0 但一条用例也没过时判失败", () => {
    const output = " Test Files  1 skipped (1)\n      Tests  3 skipped (3)\n";
    expect(evaluate({ kind: "vitest", status: 0, output }).ok).toBe(false);
  });

  it("退出码为 0 但读不到汇总时判失败", () => {
    expect(evaluate({ kind: "nextest", status: 0, output: "Finished" }).ok).toBe(false);
  });

  it("进程没起来或被杀掉时判失败", () => {
    expect(evaluate({ status: null, output: "" }).ok).toBe(false);
  });

  it("nextest 取最后一行汇总", () => {
    const output = "   Summary [  1.5s] 12 tests run: 12 passed, 3 skipped\n";
    expect(evaluate({ kind: "nextest", status: 0, output })).toEqual({
      ok: true,
      note: "12 tests run: 12 passed, 3 skipped",
    });
  });

  it("没有用例的步骤只看退出码", () => {
    expect(evaluate({ status: 0, output: "" }).ok).toBe(true);
    expect(evaluate({ status: 2, output: "error TS2322" }).ok).toBe(false);
  });
});

describe("失败详情", () => {
  it("从失败段落开始，跳过之前的进度输出", () => {
    const output = "....x\n Failed Tests 1 \nFAIL a.test.ts\n";
    expect(failureDetail("vitest", output, "log")).toBe(" Failed Tests 1 \nFAIL a.test.ts");
  });

  it("太长时截断并给出完整日志的位置", () => {
    const output = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const detail = failureDetail(undefined, output, "the.log");
    expect(detail).toContain("line 0\n");
    expect(detail).toContain("line 999");
    expect(detail).toContain("850 lines omitted, full log: the.log");
    expect(detail).not.toContain("line 500\n");
  });
});
