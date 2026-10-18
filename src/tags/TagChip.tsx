import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagOrigin } from "../bindings/TagOrigin";
import { TagMarks, UNTRANSLATED_HINT, tagName } from "../search/SearchBox";
import { confidenceBand, originLine, tagStanding, type ConfidenceThresholds } from "./tagConfidence";
import { useTagDisplay } from "./TagDisplayContext";

/** 模型标签的档位（`data-band`）；人工添加的、导入的、没有分数的不分档。 */
export function chipBand(origins: TagOrigin[], thresholds: ConfidenceThresholds) {
  const standing = tagStanding(origins);
  return standing.kind === "model" && standing.score !== null ? confidenceBand(standing.score, thresholds) : undefined;
}

/** 可信度刻度条（C）：底边一条细线，长度等于可信度。 */
export function ConfidenceMeter({ score }: { score: number }) {
  const percent = Math.round(score * 100);
  return <span className="k-tag-meter" role="meter" aria-label="可信度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    style={{ width: `${percent}%` }} />;
}

type Props = {
  tag: TagLabel;
  origins: TagOrigin[];
  /** 浮层里出处之后的补充说明，例如“统一为：…”。 */
  notes?: string[];
  /** 浮层底部的操作按钮。 */
  actions: ReactNode;
  /** 底边画可信度刻度（C）。 */
  meter?: boolean;
};

/**
 * 详情面板的一个有效标签（#160）：标签上只有名称（和未翻译图标）；模型标签按可信度带 `data-band`。
 * 悬停或聚焦时出浮层，写出处、精确可信度和操作按钮。浮层在 portal 里，不占标签的位置，
 * 悬停前后标签尺寸不变（#159）。
 */
export function TagChip({ tag, origins, notes = [], actions, meter = false }: Props) {
  const display = useTagDisplay();
  const [open, setOpen] = useState(false);
  const name = tagName(tag);
  const manual = origins.some((o) => o.kind === "manual");
  const standing = tagStanding(origins);
  const lines = [...new Set(origins.map((o) => originLine(o, display)))];
  if (tag.untranslated) lines.push(UNTRANSLATED_HINT);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger openOnHover delay={250} closeDelay={160} nativeButton={false}
        render={<li role="listitem" tabIndex={0} className={`tag-row k-tag-chip${manual ? " is-manual" : ""}`}
          data-band={display.style === "bands" ? chipBand(origins, display) : undefined} onFocus={() => setOpen(true)} />}>
        <span className="tag-name">{name}</span>
        <TagMarks tag={tag} />
        {meter && standing.kind === "model" && standing.score !== null && <ConfidenceMeter score={standing.score} />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="k-positioner" side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className="k-tip k-tag-tip" aria-label={`“${name}”的出处`} initialFocus={false} finalFocus={false}>
            {lines.map((line) => <span key={line} className="k-tag-tip-line">{line}</span>)}
            {notes.map((note) => <span key={note} className="k-tag-tip-line is-dim">{note}</span>)}
            <span className="k-tag-tip-acts">{actions}</span>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
