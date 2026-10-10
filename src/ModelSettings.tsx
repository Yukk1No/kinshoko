import { useEffect, useState } from "react";
import type { ModelChoice } from "./bindings/ModelChoice";
import type { ModelOption } from "./bindings/ModelOption";
import { PackageOpen, Sparkles } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./ui/SettingsList";
import { importModelPackage, pickModelPackage, taggingModels, taggingSetModel } from "./ipc";

const gb = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** 模型的需求：显卡档写显存，CPU 档写内存。 */
function needs(option: ModelOption): string {
  const need =
    option.device === "directMl"
      ? `显卡，显存约 ${gb(option.vramNeed)}`
      : option.ramNeed > 0
        ? `CPU，内存约 ${gb(option.ramNeed)}`
        : "CPU";
  return `${need} · ${option.installed ? "已下载" : `需下载 ${mb(option.size)}`}`;
}

/**
 * 设置 › 通用 › 自动打标：按电脑选模型（注明各自的显存或内存需求），没有网络时从文件导入模型包
 * （zip，内含模型文件与 selected_tags.csv）。换模型后已经打过标的图不会重打。
 */
export function ModelSettings() {
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    taggingModels().then(
      (value) => alive && value && setChoice(value),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  async function run(change: () => Promise<ModelChoice | null>, done: string | null) {
    setError(null);
    setMessage(null);
    try {
      const next = await change();
      if (next) {
        setChoice(next);
        setMessage(done);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function importPackage() {
    const path = await pickModelPackage();
    if (!path) return;
    setBusy(true);
    await run(() => importModelPackage(path), "模型包已导入并通过校验");
    setBusy(false);
  }

  if (!choice) return null;

  const current = choice.options.find((o) => o.key === choice.selected);
  return (
    <SettingsGroup label="自动打标">
      <SettingsRow icon={<Sparkles size={16} />} title="自动打标" desc={current ? needs(current) : "有独显时用显卡"}>
        <select className="k-select" aria-label="自动打标" value={choice.selected ?? ""}
          onChange={(e) => void run(() => taggingSetModel(e.target.value || null), null)}>
          <option value="">自动</option>
          {choice.options.map((o) => <option key={o.key} value={o.key}>{o.label} · {needs(o)}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow icon={<PackageOpen size={16} />} title="模型包" desc={busy ? "正在导入并校验…" : message ?? "没网时从文件导入"}
        below={error !== null && <p className="k-set-error" role="alert">{error}</p>}>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void importPackage()}>导入模型包…</button>
      </SettingsRow>
    </SettingsGroup>
  );
}
