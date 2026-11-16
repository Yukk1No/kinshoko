// 原型底部的切换条：换方案、换日夜、开关材质样本。它不是被评审的设计，所以用墨色实底与界面区分开。
import { useEffect } from "react";

export const VARIANTS = [
  { key: "now", name: "现状" },
  { key: "a", name: "方案 A 槽" },
  { key: "b", name: "方案 B 刻" },
  { key: "c", name: "方案 C 叠" },
  { key: "c2", name: "C2 墙做桌面" },
  { key: "c3", name: "C3 顶栏一行" },
  { key: "c4", name: "C4 米黄桌面" },
  { key: "c5", name: "C5 纸铺到边" },
  { key: "c4a", name: "C4a 分组进查找" },
  { key: "c4b", name: "C4b 分组进左栏" },
  { key: "c4c", name: "C4c 图标进查找框" },
  { key: "c4d", name: "C4d 文件夹与动作" },
  { key: "c4e", name: "C4e 选中的文件夹" },
  { key: "c4f", name: "C4f 层级：引线" },
  { key: "c4g", name: "C4g 层级：托盘" },
] as const;

export type Pose = { variant: string; theme: "light" | "dark" | null; specimen: boolean; bar: boolean };

/** 地址栏参数：variant（now / a / b / c / c2 / c3 / c4 / c5 / c4a / c4b / c4c / c4d / c4e / c4f / c4g）、theme（light / dark，不写跟随系统）、specimen=1（材质样本）、bar=0（截图时藏起切换条）。 */
export function readPose(): Pose {
  const params = new URLSearchParams(location.search);
  const variant = params.get("variant") ?? "now";
  const theme = params.get("theme");
  return {
    variant: VARIANTS.some((item) => item.key === variant) ? variant : "now",
    theme: theme === "light" || theme === "dark" ? theme : null,
    specimen: params.get("specimen") === "1",
    bar: params.get("bar") !== "0",
  };
}

function go(change: Partial<Pose>, pose: Pose) {
  const next = { ...pose, ...change };
  const params = new URLSearchParams();
  params.set("variant", next.variant);
  if (next.theme) params.set("theme", next.theme);
  if (next.specimen) params.set("specimen", "1");
  location.search = params.toString();
}

export function Switcher({ pose }: { pose: Pose }) {
  const index = VARIANTS.findIndex((item) => item.key === pose.variant);
  const step = (by: number) => go({ variant: VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length].key }, pose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 焦点在文件夹上时，← → 是折起与展开（Tree.ts），Alt + 方向键是挪位置（Folders.ts），不换方案。
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target?.closest("input, textarea, [contenteditable], button[data-folder-id]")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const dark = pose.theme === "dark" || (pose.theme === null && matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <div className="proto-bar" role="toolbar" aria-label="原型切换">
      <button type="button" onClick={() => step(-1)} aria-label="上一个方案">←</button>
      <span className="proto-bar-name">{VARIANTS[index].name}</span>
      <button type="button" onClick={() => step(1)} aria-label="下一个方案">→</button>
      <i />
      <button type="button" onClick={() => go({ theme: dark ? "light" : "dark" }, pose)}>{dark ? "夜间" : "日间"}</button>
      <button type="button" aria-pressed={pose.specimen} onClick={() => go({ specimen: !pose.specimen }, pose)}>材质样本</button>
    </div>
  );
}
