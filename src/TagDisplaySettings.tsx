import { useEffect, useState } from "react";
import { Gauge, Palette, RotateCcw, SquareDashed } from "lucide-react";
import type { TagDisplay } from "./bindings/TagDisplay";
import type { TagStyle } from "./bindings/TagStyle";
import { DEFAULT_TAG_DISPLAY, thresholdProblem } from "./tags/tagConfidence";
import { Segmented } from "./ui/Segmented";
import { SettingsGroup, SettingsRow } from "./ui/SettingsList";
import { Switch } from "./ui/Switch";
import { useTranslation } from "react-i18next";

const STEP = 0.05;
const shown = (value: number) => value.toFixed(2);
/** 输入框里的数按两位小数取，0.1 + 0.05 这类浮点尾数不进设置。 */
const parse = (text: string) => (text.trim() === "" ? Number.NaN : Math.round(Number(text) * 100) / 100);

/**
 * 设置 › 标签 › 外观（#160）：标签风格（B 按可信度分档，默认；C 按出处分组加刻度）、可信度分档阈值、
 * 低档虚线框。本设备设置，改了立即保存并生效，不需要重新打标。低档上限必须小于高档下限，不满足时不保存。
 */
export function TagDisplaySettings({ display, onChange }: {
  /** 还有没回来的保存时是最后改成的那份，否则是已接受的设置。 */
  display: TagDisplay;
  /** 在 `display` 之上改几项并保存；次序、合并与失败作废归设置页的提交模型（#321）。 */
  onChange: (change: Partial<TagDisplay>) => void;
}) {
  const { t } = useTranslation("tagSettings", { keyPrefix: "appearance" });
  const [high, setHigh] = useState(shown(display.high));
  const [low, setLow] = useState(shown(display.low));
  const [problem, setProblem] = useState<string | null>(null);
  // 阈值变了（包括保存失败后回到已接受的设置）时跟着改输入框。
  useEffect(() => {
    // 自己刚保存的阈值与输入框里的数相同时不改写输入框，免得正在输入的“0.7”变成“0.70”。
    setHigh((text) => (parse(text) === display.high ? text : shown(display.high)));
    setLow((text) => (parse(text) === display.low ? text : shown(display.low)));
    setProblem(null);
  }, [display.high, display.low]);

  const changeThresholds = (nextHigh: string, nextLow: string) => {
    setHigh(nextHigh);
    setLow(nextLow);
    const thresholds = { high: parse(nextHigh), low: parse(nextLow) };
    const why = thresholdProblem(thresholds);
    setProblem(why);
    if (why === null && (thresholds.high !== display.high || thresholds.low !== display.low)) onChange(thresholds);
  };

  return <SettingsGroup label={t("group")}>
    <SettingsRow icon={<Palette size={16} />} title={t("style")} hint={t("styleHint")}>
      <Segmented<TagStyle> label={t("style")} value={display.style} onChange={(style) => onChange({ style })} options={[
        { value: "bands", label: t("bands") }, { value: "grouped", label: t("grouped") },
      ]} />
    </SettingsRow>
    <SettingsRow className="is-thresholds" icon={<Gauge size={16} />} title={t("thresholds")} hint={t("thresholdsHint")}
      below={problem !== null && <p className="k-set-error" role="alert">{problem}</p>}>
      <label className="k-set-number">{t("high")}
        <input className="k-input is-num" type="number" aria-label={t("highLabel")} min={STEP} max={1} step={STEP} value={high}
          onChange={(e) => changeThresholds(e.target.value, low)} />
      </label>
      <label className="k-set-number">{t("low")}
        <input className="k-input is-num" type="number" aria-label={t("lowLabel")} min={0} max={1 - STEP} step={STEP} value={low}
          onChange={(e) => changeThresholds(high, e.target.value)} />
      </label>
      <button type="button" className="k-btn is-sm is-quiet" onClick={() => {
        setProblem(null);
        setHigh(shown(DEFAULT_TAG_DISPLAY.high));
        setLow(shown(DEFAULT_TAG_DISPLAY.low));
        onChange({ high: DEFAULT_TAG_DISPLAY.high, low: DEFAULT_TAG_DISPLAY.low });
      }}><RotateCcw size={12} aria-hidden="true" /><span className="k-label">{t("reset")}</span></button>
    </SettingsRow>
    <SettingsRow icon={<SquareDashed size={16} />} title={t("lowOutline")} hint={t("lowOutlineHint")}>
      <Switch label={t("lowOutline")} checked={display.lowOutline} onCheckedChange={(on) => onChange({ lowOutline: on })} />
    </SettingsRow>
  </SettingsGroup>;
}
