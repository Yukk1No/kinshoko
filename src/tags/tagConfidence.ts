import type { TagDisplay } from "../bindings/TagDisplay";
import { i18n } from "../i18n/instance";
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
  if (!inRange(high) || !inRange(low)) return i18n.t("tagSettings:appearance.outOfRange");
  if (low >= high) return i18n.t("tagSettings:appearance.lowAboveHigh");
  return null;
}

/** 分数落在哪一档：≥ high 为高，< low 为低，其余为中。 */
export function confidenceBand(score: number, { high, low }: ConfidenceThresholds): ConfidenceBand {
  if (score >= high - EPSILON) return "high";
  if (score < low - EPSILON) return "low";
  return "mid";
}

/**
 * 显示用的整数百分比，向下取整：0.799 显示 79% 而不是 80%，和它所在的中档一致。
 * 阈值是两位小数，所以向下取整的百分比和 `confidenceBand` 在任何阈值下都落在同一边；浮点误差按同样的 EPSILON 放过。
 */
export function confidencePercent(score: number): number {
  return Math.floor(score * 100 + EPSILON * 100);
}

/** 有效标签按出处归类：人工确认或添加的（以及合并资料库时留下、暂按添加处理的决定冲突）不分档；模型给的取各模型来源的最高分；其余是导入等来源。 */
export type TagStanding = { kind: "manual" } | { kind: "model"; score: number | null } | { kind: "imported" };

const isModel = (origin: TagOrigin): origin is Extract<TagOrigin, { kind: "source" }> =>
  origin.kind === "source" && origin.source.startsWith("model:");

export function tagStanding(origins: TagOrigin[]): TagStanding {
  if (origins.some((o) => o.kind === "manual" || o.kind === "conflict")) return { kind: "manual" };
  const models = origins.filter(isModel);
  if (models.length === 0) return { kind: "imported" };
  const scores = models.flatMap((o) => (o.score === null ? [] : [o.score]));
  return { kind: "model", score: scores.length ? Math.max(...scores) : null };
}


/** 浮层里一个出处的说明，例如“来源：打标模型 · 可信度 87%（高）”。 */
export function originLine(origin: TagOrigin, thresholds: ConfidenceThresholds): string {
  if (origin.kind === "manual") return i18n.t("tags:origin.manual");
  if (origin.kind === "conflict") return i18n.t("tags:origin.conflict");
  const { source, score } = origin;
  if (isModel(origin)) {
    return score === null
      ? i18n.t("tags:origin.model")
      : i18n.t("tags:origin.modelScore", { percent: confidencePercent(score), band: i18n.t(`tags:origin.band.${confidenceBand(score, thresholds)}`) });
  }
  if (source.startsWith("eagle:")) return i18n.t("tags:origin.eagle");
  if (source.startsWith("package:")) return i18n.t("tags:origin.package");
  if (source === "restore") return i18n.t("tags:origin.restore");
  return i18n.t("tags:origin.imported");
}
