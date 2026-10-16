// PROTOTYPE（反馈 4，顶栏 B）：“精确查找”从查找框里搬到标签分组行最前，改名为“展开相近标签”开关。
// 开关只是代按查找框里那颗（已隐藏的）真按钮，状态读它的 aria-pressed。
import { useEffect, useState, type ComponentProps } from "react";
import { TagGroupBar as Real } from "../../src/search/TagGroupBar";
import { Switch } from "../../src/ui/Switch";

export function TagGroupBar(props: ComponentProps<typeof Real>) {
  const bar = document.documentElement.dataset.bar;
  const [exact, setExact] = useState(props.input.exact);
  useEffect(() => setExact(props.input.exact), [props.input.exact]);
  if (bar !== "B") return <Real {...props} />;
  return <div className="proto-tagrow">
    <label className="proto-expand" title="查“蓝瞳”时也找“水色瞳”等相近标签">
      <Switch size="sm" label="展开相近标签" checked={!exact}
        onCheckedChange={() => (document.querySelector(".search-exact") as HTMLButtonElement | null)?.click()} />
      <span>展开相近</span>
    </label>
    <span className="proto-tagrow-sep" aria-hidden="true" />
    <Real {...props} />
  </div>;
}
