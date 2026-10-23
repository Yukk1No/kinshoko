import { describe, expect, it } from "vitest";
import { DEFAULT_TAG_DISPLAY, confidenceBand, confidencePercent, originLine, tagStanding, thresholdProblem } from "./tagConfidence";

const defaults = { high: 0.8, low: 0.4 };

describe("可信度分档（#160）", () => {
  it("默认阈值下 0.80 归高档，0.79 归中档，0.40 归中档，0.39 归低档", () => {
    expect(confidenceBand(0.8, defaults)).toBe("high");
    expect(confidenceBand(0.79, defaults)).toBe("mid");
    expect(confidenceBand(0.4, defaults)).toBe("mid");
    expect(confidenceBand(0.39, defaults)).toBe("low");
  });

  it("改了阈值后档位随之变化", () => {
    expect(confidenceBand(0.79, { high: 0.75, low: 0.5 })).toBe("high");
    expect(confidenceBand(0.45, { high: 0.75, low: 0.5 })).toBe("low");
  });
});

describe("标签的出处归类", () => {
  const model = (score: number | null, source = "model:pixai") => ({ kind: "source" as const, source, score });

  it("人工确认或添加的标签不参与分档，即使模型也给了分", () => {
    expect(tagStanding([{ kind: "manual" }, model(0.99)])).toEqual({ kind: "manual" });
  });

  it("合并资料库留下的决定冲突按添加处理，和人工添加归在一起", () => {
    expect(tagStanding([{ kind: "conflict" }])).toEqual({ kind: "manual" });
    expect(tagStanding([{ kind: "conflict" }, model(0.3)])).toEqual({ kind: "manual" });
  });

  it("多个模型来源时取最高分", () => {
    expect(tagStanding([model(0.42, "model:a"), model(0.86, "model:b"), model(null, "model:c")])).toEqual({ kind: "model", score: 0.86 });
  });

  it("没有分数的模型来源仍算模型，档位未知", () => {
    expect(tagStanding([model(null)])).toEqual({ kind: "model", score: null });
  });

  it("Eagle、参考组包、备份等导入来源归为导入", () => {
    expect(tagStanding([{ kind: "source", source: "eagle:lib1", score: null }])).toEqual({ kind: "imported" });
    expect(tagStanding([{ kind: "source", source: "package:p", score: null }, { kind: "source", source: "restore", score: null }])).toEqual({ kind: "imported" });
  });
});

describe("悬停浮层里的出处说明", () => {
  it("模型来源写成百分比和档位，导入写明来源", () => {
    expect(originLine({ kind: "source", source: "model:pixai", score: 0.87 }, defaults)).toBe("自动标签，可信度 87%（高）");
    expect(originLine({ kind: "source", source: "model:pixai", score: 0.4 }, defaults)).toBe("自动标签，可信度 40%（中）");
    expect(originLine({ kind: "source", source: "model:pixai", score: null }, defaults)).toBe("自动标签");
    expect(originLine({ kind: "source", source: "eagle:lib1", score: null }, defaults)).toBe("来源：从 Eagle 导入");
    expect(originLine({ kind: "source", source: "package:x", score: null }, defaults)).toBe("来源：参考组包");
    expect(originLine({ kind: "source", source: "restore", score: null }, defaults)).toBe("来源：备份");
    expect(originLine({ kind: "manual" }, defaults)).toBe("来源：你添加的");
    expect(originLine({ kind: "conflict" }, defaults)).toBe("来源：合并时的决定冲突，暂按添加处理");
  });
});

describe("显示的百分比与档位一致", () => {
  it("贴近阈值的分数不进位到下一档的数字", () => {
    expect(originLine({ kind: "source", source: "model:pixai", score: 0.799 }, defaults)).toBe("自动标签，可信度 79%（中）");
    expect(originLine({ kind: "source", source: "model:pixai", score: 0.399 }, defaults)).toBe("自动标签，可信度 39%（低）");
  });

  it("浮点误差内落在阈值上的分数显示阈值本身", () => {
    expect(confidencePercent(0.29)).toBe(29);
    expect(confidencePercent(0.8 - 1e-9)).toBe(80);
    expect(confidencePercent(0.87)).toBe(87);
  });
});

describe("分档阈值的约束", () => {
  it("低档上限必须小于高档下限", () => {
    expect(thresholdProblem({ high: 0.8, low: 0.4 })).toBeNull();
    expect(thresholdProblem({ high: 0.6, low: 0.6 })).toBe("低档上限要小于高档下限");
    expect(thresholdProblem({ high: 0.5, low: 0.7 })).toBe("低档上限要小于高档下限");
  });

  it("阈值在 0 到 1 之间", () => {
    expect(thresholdProblem({ high: 1.05, low: 0.4 })).toBe("阈值要在 0 到 1 之间");
    expect(thresholdProblem({ high: 0.8, low: -0.05 })).toBe("阈值要在 0 到 1 之间");
    expect(thresholdProblem({ high: Number.NaN, low: 0.4 })).toBe("阈值要在 0 到 1 之间");
  });

  it("默认是底色分档、0.80 / 0.40、低档加虚线框", () => {
    expect(DEFAULT_TAG_DISPLAY).toEqual({ style: "bands", high: 0.8, low: 0.4, lowOutline: true });
  });
});
