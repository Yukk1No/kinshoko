// 门槛实验的“钉图离屏渲染 vs 正式派生图”（#282）：Rust 在钉图渲染层上画出每个样本、经查找表到主显示器，
// 与 moxcms 直接转换比较。这里只做判定、表格与报告段落。
import type { PinGate } from "../bindings/PinGate";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n/instance";

const t = i18n.getFixedT(null, "fidelity");

/** 与 Rust 的 `PinGate::passed` 相同：计入门槛的样本最差色块 ΔE2000 < 1，且没有出错。 */
export function pinGatePassed(pins: PinGate): boolean {
  return (
    pins.error === null &&
    pins.items.every((i) => !i.gated || (i.error === null && i.worstDeltaE !== null && i.worstDeltaE < 1))
  );
}

function verdict(i: PinGate["items"][number]): string {
  if (i.error) return t("error", { error: i.error });
  if (!i.gated) return t("recordOnly");
  return i.worstDeltaE !== null && i.worstDeltaE < 1 ? t("passed") : t("failed");
}

/** 报告里的一节。 */
export function pinGateMarkdown(pins: PinGate): string[] {
  const lines = [
    t("report.pinsTitle"),
    "",
    t("report.pinsVerdict", {
      verdict: t(pinGatePassed(pins) ? "passed" : "failed"),
      adapter: pins.adapter || "—",
      display: pins.display,
    }),
    "",
  ];
  if (pins.error) return [...lines, t("error", { error: pins.error }), ""];
  lines.push(t("report.pinsHeader"), "|---|---|---|---|---|");
  for (const i of pins.items) {
    lines.push(
      `| ${i.fileName} | ${t(i.gated ? "yes" : "no")} | ${i.worstDeltaE?.toFixed(2) ?? "—"} | ${t("pins.diffValue", { mean: i.mean.toFixed(2), p99: i.p99, max: i.max })} | ${verdict(i)} |`,
    );
  }
  return [...lines, ""];
}

export function PinGateSection({ pins }: { pins: PinGate | null }) {
  const { t } = useTranslation("fidelity");
  return (
    <section>
      <h2>{t("pins.title")}</h2>
      {!pins && <p>{t("pins.drawing")}</p>}
      {pins && (
        <p>
          {t("pins.summary", {
            adapter: pins.adapter || "—",
            display: pins.display,
            verdict: t(pinGatePassed(pins) ? "passed" : "failed"),
          })}
          {pins.error && t("pins.error", { error: pins.error })}
        </p>
      )}
      {pins && !pins.error && (
        <table className="gate-table">
          <thead>
            <tr>
              <th>{t("column.sample")}</th>
              <th>{t("pins.worst")}</th>
              <th>{t("pins.diff")}</th>
              <th>{t("column.result")}</th>
            </tr>
          </thead>
          <tbody>
            {pins.items.map((i) => (
              <tr key={i.fileName}>
                <td>{i.fileName}</td>
                <td>{i.worstDeltaE?.toFixed(2) ?? "—"}</td>
                <td>{t("pins.diffValue", { mean: i.mean.toFixed(2), p99: i.p99, max: i.max })}</td>
                <td>{verdict(i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
