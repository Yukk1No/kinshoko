import { Toggle } from "@base-ui/react/toggle";
import { Tooltip } from "@base-ui/react/tooltip";

/**
 * 精确查找 (#102 故事13, 方案 C3): a quiet 32 × 32 icon toggle at the end of the search field.
 * Off (含相近) shows two waves, on (仅精确) two straight lines; one squashes out while the other opens.
 * Both strokes sit centred on a 16 px grid. The tooltip names the current state and what a press does.
 */
export function ExactToggle({ exact, onChange }: { exact: boolean; onChange: (exact: boolean) => void }) {
  const tip = exact ? "仅精确：只查选中的标签。按下改为含相近" : "含相近：同时查相近标签。按下改为仅精确";
  return <Tooltip.Root>
    <Tooltip.Trigger delay={400} closeOnClick={false}
      render={<Toggle className="k-exact" aria-label="精确查找" pressed={exact} onPressedChange={(next) => onChange(next)} />}>
      <svg className="k-exact-glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path className="k-exact-wave" d="M3 6c1.6-1.6 3.4-1.6 5 0s3.4 1.6 5 0M3 10c1.6-1.6 3.4-1.6 5 0s3.4 1.6 5 0" />
        <path className="k-exact-line" d="M3.5 6h9M3.5 10h9" />
      </svg>
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Positioner className="k-positioner" side="bottom" sideOffset={8}>
        <Tooltip.Popup className="k-tip">{tip}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
