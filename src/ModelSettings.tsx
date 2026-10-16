import { useEffect, useState } from "react";
import type { ModelChoice } from "./bindings/ModelChoice";
import type { ModelOption } from "./bindings/ModelOption";
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
 * 设置中“自动标签模型”一节：按电脑选模型（注明各自的显存或内存需求），
 * 没有网络时从文件导入模型包。
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

  const option = (key: string | null, title: string, detail: string | null) => (
    <label className="settings-row" key={key ?? "auto"}>
      <input
        type="radio"
        name="tagging-model"
        checked={choice.selected === key}
        onChange={() => void run(() => taggingSetModel(key), null)}
      />
      <span>
        {title}
        {detail && <span className="settings-hint"> {detail}</span>}
      </span>
    </label>
  );

  return (
    <section className="settings" aria-label="自动标签模型">
      <h2>自动标签模型</h2>
      {option(null, "自动", "有独显时用显卡模型，没有时用 CPU 模型")}
      {choice.options.map((o) => option(o.key, o.label, needs(o)))}
      <p className="settings-hint">
        换模型后已经打过标的图不会重打。没有网络时，可以导入在别处下好的模型包（zip，内含模型文件与
        selected_tags.csv）。
      </p>
      <div className="settings-row">
        <button type="button" disabled={busy} onClick={() => void importPackage()}>
          从文件导入模型包…
        </button>
        {busy && <span className="settings-hint">正在导入并校验…</span>}
        {message && <span className="settings-hint">{message}</span>}
      </div>
      {error !== null && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
