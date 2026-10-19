import { useEffect, useRef, useState } from "react";
import { Gauge, Palette, RotateCcw, SquareDashed } from "lucide-react";
import type { TagDisplay } from "./bindings/TagDisplay";
import type { TagStyle } from "./bindings/TagStyle";
import { DEFAULT_TAG_DISPLAY, thresholdProblem } from "./tags/tagConfidence";
import { Segmented } from "./ui/Segmented";
import { SettingsGroup, SettingsRow } from "./ui/SettingsList";
import { Switch } from "./ui/Switch";

const STEP = 0.05;
const shown = (value: number) => value.toFixed(2);
/** 输入框里的数按两位小数取，0.1 + 0.05 这类浮点尾数不进设置。 */
const parse = (text: string) => (text.trim() === "" ? Number.NaN : Math.round(Number(text) * 100) / 100);

/**
 * 设置 › 标签 › 外观（#160）：标签风格（B 按可信度分档，默认；C 按出处分组加刻度）、可信度分档阈值、
 * 低档虚线框。本设备设置，改了立即保存并生效，不需要重新打标。低档上限必须小于高档下限，不满足时不保存。
 */
export function TagDisplaySettings({ display, onSave }: { display: TagDisplay; onSave: (next: TagDisplay) => Promise<unknown> }) {
  const [high, setHigh] = useState(shown(display.high));
  const [low, setLow] = useState(shown(display.low));
  const [problem, setProblem] = useState<string | null>(null);
  // 连着改几项时，后一项要在前一项之上改。保存一次只发一个，等它回来再发最新的那份；
  // 还有没保存完的改动时不拿回来的 display 覆盖，否则先回来的旧结果会把后改的盖回去。
  const latest = useRef(display);
  const [shownDisplay, setShownDisplay] = useState(display);
  const saving = useRef(false);
  const queued = useRef(false);
  useEffect(() => {
    if (saving.current) return;
    latest.current = display;
    setShownDisplay(display);
  }, [display]);
  useEffect(() => {
    if (saving.current) return;
    setHigh(shown(display.high));
    setLow(shown(display.low));
    setProblem(null);
  }, [display.high, display.low]);
  const save = (change: Partial<TagDisplay>) => {
    latest.current = { ...latest.current, ...change };
    setShownDisplay(latest.current);
    queued.current = true;
    if (saving.current) return;
    saving.current = true;
    void (async () => {
      while (queued.current) {
        queued.current = false;
        await onSave(latest.current);
      }
      saving.current = false;
    })();
  };

  const changeThresholds = (nextHigh: string, nextLow: string) => {
    setHigh(nextHigh);
    setLow(nextLow);
    const thresholds = { high: parse(nextHigh), low: parse(nextLow) };
    const why = thresholdProblem(thresholds);
    setProblem(why);
    if (why === null && (thresholds.high !== latest.current.high || thresholds.low !== latest.current.low)) save(thresholds);
  };

  return <SettingsGroup label="标签外观">
    <SettingsRow icon={<Palette size={16} />} title="标签外观" desc="详情面板和查看器里的标签">
      <Segmented<TagStyle> label="标签外观" value={shownDisplay.style} onChange={(style) => save({ style })} options={[
        { value: "bands", label: "按可信度分档" }, { value: "grouped", label: "按出处分组" },
      ]} />
    </SettingsRow>
    <SettingsRow className="is-thresholds" icon={<Gauge size={16} />} title="可信度分档" desc="模型给的标签分高、中、低三档"
      below={problem !== null && <p className="k-set-error" role="alert">{problem}</p>}>
      <label className="k-set-number">高档不低于
        <input className="k-input" type="number" aria-label="高档下限" min={STEP} max={1} step={STEP} value={high}
          onChange={(e) => changeThresholds(e.target.value, low)} />
      </label>
      <label className="k-set-number">低档低于
        <input className="k-input" type="number" aria-label="低档上限" min={0} max={1 - STEP} step={STEP} value={low}
          onChange={(e) => changeThresholds(high, e.target.value)} />
      </label>
      <button type="button" className="k-btn is-sm is-quiet" onClick={() => {
        setProblem(null);
        setHigh(shown(DEFAULT_TAG_DISPLAY.high));
        setLow(shown(DEFAULT_TAG_DISPLAY.low));
        save({ high: DEFAULT_TAG_DISPLAY.high, low: DEFAULT_TAG_DISPLAY.low });
      }}><RotateCcw size={12} aria-hidden="true" />恢复默认</button>
    </SettingsRow>
    <SettingsRow icon={<SquareDashed size={16} />} title="低档虚线框" desc="低档标签加虚线外框；关掉后只把字变浅">
      <Switch label="低档虚线框" checked={shownDisplay.lowOutline} onCheckedChange={(on) => save({ lowOutline: on })} />
    </SettingsRow>
  </SettingsGroup>;
}
