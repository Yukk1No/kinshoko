import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { useTranslation } from "react-i18next";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagOrigin } from "../bindings/TagOrigin";
import { TagMarks, tagName, untranslatedHint } from "../search/SearchBox";
import { Sparkles } from "lucide-react";
import { confidenceBand, confidencePercent, isModel, originLine, tagStanding, type ConfidenceThresholds } from "./tagConfidence";
import { useTagDisplay } from "./TagDisplayContext";
import { UntranslatedRename } from "./UntranslatedRename";

/** 模型标签的档位（`data-band`）；没有分数的按中档（#482）。人工添加的、导入的不分档。 */
export function chipBand(origins: TagOrigin[], thresholds: ConfidenceThresholds) {
  const standing = tagStanding(origins);
  if (standing.kind !== "model") return undefined;
  return standing.score === null ? "mid" : confidenceBand(standing.score, thresholds);
}

/** 可信度刻度条（C）：底边一条细线，长度等于可信度。 */
export function ConfidenceMeter({ score }: { score: number }) {
  const { t } = useTranslation("tags");
  const percent = confidencePercent(score);
  return <span className="k-tag-meter" role="meter" aria-label={t("origin.confidence")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
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
  /** 有统一标签身份时，尚未翻译的“文/A”是改名按钮（#182）。 */
  rename?: { catalogId: string; onSaved: () => void };
};

/**
 * 详情面板的一个有效标签（#160）：标签上只有名称（和未翻译图标）；模型标签按可信度带 `data-band`。
 * 悬停或聚焦时出浮层，写出处、精确可信度和操作按钮。浮层在 portal 里，不占标签的位置，
 * 悬停前后标签尺寸不变（#159）。
 */
export function TagChip({ tag, origins, notes = [], actions, meter = false, rename }: Props) {
  const { t } = useTranslation("tags");
  const display = useTagDisplay();
  const [open, setOpen] = useState(false);
  // 改名框开着时不出出处浮层，两个浮层不叠在一起。
  const [renaming, setRenaming] = useState(false);
  const name = tagName(tag);
  const standing = tagStanding(origins);
  const manual = standing.kind === "manual";
  // 出自打标模型的那行前面是星，星在 Kinshoko 里代表“智能”（#482）。
  const lines = [...new Map(origins.map((o) => [originLine(o, display), isModel(o)] as const)).entries()];
  if (tag.untranslated) lines.push([untranslatedHint(), false]);
  return (
    <Popover.Root open={open && !renaming} onOpenChange={setOpen}>
      <Popover.Trigger openOnHover delay={250} closeDelay={160} nativeButton={false}
        render={<li role="listitem" tabIndex={0} className={`tag-row k-tag-chip${manual ? " is-manual" : ""}`}
          data-band={display.style === "bands" ? chipBand(origins, display) : undefined} onFocus={() => setOpen(true)} />}>
        <span className="tag-name">{name}</span>
        <TagMarks tag={tag} untranslated={rename && <UntranslatedRename tag={tag} catalogId={rename.catalogId} onSaved={rename.onSaved} onOpenChange={setRenaming} />} />
        {meter && standing.kind === "model" && standing.score !== null && <ConfidenceMeter score={standing.score} />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="k-positioner" side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className="k-tip k-tag-tip" aria-label={t("origin.label", { name })} initialFocus={false} finalFocus={false}>
            {lines.map(([line, model]) => <span key={line} className="k-tag-tip-line">{model && <Sparkles size={12} aria-hidden="true" />}{line}</span>)}
            {notes.map((note) => <span key={note} className="k-tag-tip-line is-dim">{note}</span>)}
            <span className="k-tag-tip-acts">{actions}</span>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
