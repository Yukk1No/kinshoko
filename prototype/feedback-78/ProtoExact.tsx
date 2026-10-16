// PROTOTYPE（反馈 4，顶栏 C 系列）：查找框尾部的“含相近 / 仅精确”，全部用项目已有的组件拼：
// C  = 项目的 Segmented（Base UI ToggleGroup）+ motion 滑块（提议给共用 Segmented 加上，内容分级、设置也受益）
// C2 = 项目的 Switch（Base UI Switch）+ “仅精确”文字
// C3 = Base UI Toggle 做的图标按钮 + Tooltip
// 都只是代按查找框里隐藏的真按钮 .search-exact，状态读它的 aria-pressed。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle } from "@base-ui/react/toggle";
import { Tooltip } from "@base-ui/react/tooltip";
import { Switch } from "../../src/ui/Switch";
import { spring } from "../../src/ui/vendor/fluid/springs";

function useExact() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [exact, setExact] = useState(false);
  useEffect(() => {
    const sync = () => {
      const button = document.querySelector<HTMLButtonElement>(".search-exact");
      setHost(document.querySelector<HTMLElement>(".topbar > .search"));
      setExact(button?.getAttribute("aria-pressed") === "true");
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed"] });
    return () => mo.disconnect();
  }, []);
  const toggle = () => document.querySelector<HTMLButtonElement>(".search-exact")?.click();
  return { host, exact, toggle };
}

const OPTIONS = [
  { value: "near", label: "含相近", title: "查“蓝瞳”时也找“水色瞳”等相近标签" },
  { value: "exact", label: "仅精确", title: "只查选中的标签本身" },
] as const;

function SegmentedSlider({ exact, toggle }: { exact: boolean; toggle: () => void }) {
  const value = exact ? "exact" : "near";
  return <ToggleGroup className="k-seg proto-exact-seg" aria-label="相近标签" value={[value]}
    onValueChange={(next) => { if (next[0] && next[0] !== value) toggle(); }}>
    {OPTIONS.map((o) => <Toggle key={o.value} value={o.value} className="k-seg-item" title={o.title}>
      {o.value === value && <motion.span layoutId="proto-exact-thumb" className="proto-seg-thumb" transition={spring.moderate} />}
      <span className="proto-seg-label">{o.label}</span>
    </Toggle>)}
  </ToggleGroup>;
}

function SwitchSuffix({ exact, toggle }: { exact: boolean; toggle: () => void }) {
  return <label className="proto-exact-switch" title="打开后只查选中的标签本身，不展开相近标签">
    <span>仅精确</span>
    <Switch size="sm" label="仅精确查找" checked={exact} onCheckedChange={toggle} />
  </label>;
}

function IconToggle({ exact, toggle }: { exact: boolean; toggle: () => void }) {
  return <Tooltip.Provider delay={300}>
    <Tooltip.Root>
      <Tooltip.Trigger render={<Toggle pressed={exact} onPressedChange={toggle} className="proto-exact-icon" aria-label="仅精确查找"
        data-tone={new URLSearchParams(location.search).get("tone") ?? "gold"} />}>
        {/* 字体里的 ≈ / = 基线偏下，改画 16 px 网格上居中的两道线：波浪 = 含相近，直线 = 仅精确。 */}
        <svg className="proto-glyph is-near" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6.2c1.6-1.6 3.4-1.6 5 0s3.4 1.6 5 0M3 10.2c1.6-1.6 3.4-1.6 5 0s3.4 1.6 5 0" /></svg>
        <svg className="proto-glyph is-exact" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6h9M3.5 10h9" /></svg>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8}>
          <Tooltip.Popup className="proto-tip">{exact ? "仅精确：只查选中的标签" : "含相近：也找相近标签"}<kbd>点按切换</kbd></Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>;
}

export function ProtoExact() {
  const bar = document.documentElement.dataset.bar ?? "0";
  const { host, exact, toggle } = useExact();
  if (!host || !bar.startsWith("C")) return null;
  const body = bar === "C" ? <SegmentedSlider exact={exact} toggle={toggle} />
    : bar === "C2" ? <SwitchSuffix exact={exact} toggle={toggle} /> : <IconToggle exact={exact} toggle={toggle} />;
  return createPortal(<div className="proto-exact-host">{body}</div>, host);
}
