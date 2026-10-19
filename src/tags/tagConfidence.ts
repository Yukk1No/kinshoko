import type { TagDisplay } from "../bindings/TagDisplay";
import type { TagOrigin } from "../bindings/TagOrigin";

/** 模型标签的可信度档位（#160）：高档深底，中档常规底，低档字变浅。 */
export type ConfidenceBand = "high" | "mid" | "low";

/** 分档阈值：`high` 是高档下限，`low` 是低档上限（不含），满足 `low < high`。 */
export type ConfidenceThresholds = { high: number; low: number };

// 分数和阈值都按两位小数写（0.80、0.40），浮点误差不该让正好落在阈值上的分数掉一档。
const EPSILON = 1e-6;

/**
 * 标签外观的默认值，与核心的 `TagDisplay::default` 相同：底色分档，0.80 / 0.40，低档加虚线框。
 * 阈值来自维护者测试库的 13,837 个模型标签，这样分高、中、低三档大约各占三分之一。
 */
export const DEFAULT_TAG_DISPLAY: TagDisplay = { style: "bands", high: 0.8, low: 0.4, lowOutline: true };

/** 阈值哪里不合要求；没问题时返回 null。核心按同样的规则拒绝保存。 */
export function thresholdProblem({ high, low }: ConfidenceThresholds): string | null {
  const inRange = (value: number) => value >= 0 && value <= 1;
  if (!inRange(high) || !inRange(low)) return "阈值要在 0 到 1 之间";
  if (low >= high) return "低档上限要小于高档下限";
  return null;
}

/** 分数落在哪一档：≥ high 为高，< low 为低，其余为中。 */
export function confidenceBand(score: number, { high, low }: ConfidenceThresholds): ConfidenceBand {
  if (score >= high - EPSILON) return "high";
  if (score < low - EPSILON) return "low";
  return "mid";
}

/** 有效标签按出处归类：人工确认或添加的不分档；模型给的取各模型来源的最高分；其余是导入等来源。 */
export type TagStanding = { kind: "manual" } | { kind: "model"; score: number | null } | { kind: "imported" };

const isModel = (origin: TagOrigin): origin is Extract<TagOrigin, { kind: "source" }> =>
  origin.kind === "source" && origin.source.startsWith("model:");

export function tagStanding(origins: TagOrigin[]): TagStanding {
  if (origins.some((o) => o.kind === "manual")) return { kind: "manual" };
  const models = origins.filter(isModel);
  if (models.length === 0) return { kind: "imported" };
  const scores = models.flatMap((o) => (o.score === null ? [] : [o.score]));
  return { kind: "model", score: scores.length ? Math.max(...scores) : null };
}

const BAND_WORD: Record<ConfidenceBand, string> = { high: "高", mid: "中", low: "低" };

/** 浮层里一个出处的说明，例如“来源：打标模型 · 可信度 87%（高）”。 */
export function originLine(origin: TagOrigin, thresholds: ConfidenceThresholds): string {
  if (origin.kind === "manual") return "来源：你添加的";
  if (origin.kind === "conflict") return "来源：合并时的决定冲突，暂按添加处理";
  const { source, score } = origin;
  if (isModel(origin)) {
    return score === null
      ? "来源：打标模型"
      : `来源：打标模型 · 可信度 ${Math.round(score * 100)}%（${BAND_WORD[confidenceBand(score, thresholds)]}）`;
  }
  if (source.startsWith("eagle:")) return "来源：从 Eagle 导入";
  if (source.startsWith("package:")) return "来源：参考组包";
  if (source === "restore") return "来源：备份";
  return "来源：导入";
}
