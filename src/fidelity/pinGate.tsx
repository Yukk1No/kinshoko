// 门槛实验的“钉图离屏渲染 vs 正式派生图”（#282）：Rust 在钉图渲染层上画出每个样本、经查找表到主显示器，
// 与 moxcms 直接转换比较。这里只做判定、表格与报告段落。
import type { PinGate } from "../bindings/PinGate";

/** 与 Rust 的 `PinGate::passed` 相同：计入门槛的样本最差色块 ΔE2000 < 1，且没有出错。 */
export function pinGatePassed(pins: PinGate): boolean {
  return (
    pins.error === null &&
    pins.items.every((i) => !i.gated || (i.error === null && i.worstDeltaE !== null && i.worstDeltaE < 1))
  );
}

function verdict(i: PinGate["items"][number]): string {
  if (i.error) return `出错：${i.error}`;
  if (!i.gated) return "只记录";
  return i.worstDeltaE !== null && i.worstDeltaE < 1 ? "通过" : "未通过";
}

/** 报告里的一节。 */
export function pinGateMarkdown(pins: PinGate): string[] {
  const lines = [
    "## 钉图离屏渲染 vs 正式派生图",
    "",
    `结论：${pinGatePassed(pins) ? "通过" : "未通过"}；适配器：${pins.adapter || "—"}；显示器：${pins.display}`,
    "",
  ];
  if (pins.error) return [...lines, `出错：${pins.error}`, ""];
  lines.push("| 样本 | 门槛 | 最差色块 ΔE2000 | 8 位差 均值／p99／最大 | 结果 |", "|---|---|---|---|---|");
  for (const i of pins.items) {
    lines.push(
      `| ${i.fileName} | ${i.gated ? "是" : "否"} | ${i.worstDeltaE?.toFixed(2) ?? "—"} | ${i.mean.toFixed(2)}／${i.p99}／${i.max} | ${verdict(i)} |`,
    );
  }
  return [...lines, ""];
}

export function PinGateSection({ pins }: { pins: PinGate | null }) {
  return (
    <section>
      <h2>钉图离屏渲染 vs 正式派生图</h2>
      {!pins && <p>正在钉图渲染层上画样本……</p>}
      {pins && (
        <p>
          适配器：{pins.adapter || "—"}；显示器：{pins.display}；结论：{pinGatePassed(pins) ? "通过" : "未通过"}
          {pins.error && `（出错：${pins.error}）`}
        </p>
      )}
      {pins && !pins.error && (
        <table className="gate-table">
          <thead>
            <tr>
              <th>样本</th>
              <th>最差色块 ΔE2000</th>
              <th>8 位差 均值／p99／最大</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {pins.items.map((i) => (
              <tr key={i.fileName}>
                <td>{i.fileName}</td>
                <td>{i.worstDeltaE?.toFixed(2) ?? "—"}</td>
                <td>
                  {i.mean.toFixed(2)}／{i.p99}／{i.max}
                </td>
                <td>{verdict(i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
