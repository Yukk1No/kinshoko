// PROTOTYPE：底部浮条，切换顶栏（反馈 4）与侧栏（反馈 9）方案。←/→ 切顶栏，Shift+←/→ 切侧栏。
import { useEffect } from "react";

export const BARS: Record<string, string> = { "0": "现状", A: "A 安静一体", B: "B 轻量分组", C: "C 工具岛 · 分段", C2: "C2 · 开关", C3: "C3 · 图标" };
export const TONES: Record<string, string> = { gold: "金", sakura: "樱粉", ink: "墨紫" };
export const SIDES: Record<string, string> = { "0": "现状", A: "A 树即范围", B: "B 范围头 + 树", C: "C 图库标签页", D: "D = A 外观 + B 只开一个" };

function go(key: "bar" | "side", dir: number) {
  const table = key === "bar" ? BARS : SIDES;
  const keys = Object.keys(table);
  const p = new URLSearchParams(location.search);
  const cur = p.get(key) ?? "0";
  p.set(key, keys[(keys.indexOf(cur) + dir + keys.length) % keys.length]);
  location.search = p.toString();
}

export function Switcher() {
  const p = new URLSearchParams(location.search);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); go(e.shiftKey ? "side" : "bar", e.key === "ArrowLeft" ? -1 : 1); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const row = (key: "bar" | "side", name: string, table: Record<string, string>) => (
    <div className="proto-row">
      <span className="proto-k">{name}</span>
      <button type="button" onClick={() => go(key, -1)}>‹</button>
      <b>{table[p.get(key) ?? "0"]}</b>
      <button type="button" onClick={() => go(key, 1)}>›</button>
    </div>
  );
  return <div className="proto-switcher" aria-hidden="true">
    {row("bar", "顶栏 ←→", BARS)}
    {row("side", "侧栏 ⇧←→", SIDES)}
    {(p.get("bar") ?? "").startsWith("C3") && <div className="proto-row"><span className="proto-k">开启色</span>
      {Object.entries(TONES).map(([k, v]) => <button key={k} type="button" style={{ background: (p.get("tone") ?? "gold") === k ? "#666" : "#333" }}
        onClick={() => { p.set("tone", k); location.search = p.toString(); }}>{v}</button>)}</div>}
  </div>;
}
