import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cpu, PackageOpen, Sparkles, Tags } from "lucide-react";
import type { Device } from "./bindings/Device";
import type { HardwareOption } from "./bindings/HardwareOption";
import type { ModelChoice } from "./bindings/ModelChoice";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { SettingsGroup, SettingsRow } from "./ui/SettingsList";
import { importModelPackage, pickModelPackage, taggingDownload, taggingModels, taggingPause, taggingResume, taggingSetDevice } from "./ipc";
import { useTaggingStatus } from "./useTaggingStatus";

const gb = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
const percent = (part: number, total: number) => (total > 0 ? Math.floor((part / total) * 100) : 0);
const DEVICE_NAME: Record<Device, string> = { directMl: "显卡", cpu: "CPU" };

/** 一个硬件档：名称 · 显存或内存需求 · 是否已下载。不写精度（FP16/FP32 随档位定，画师不用管）。 */
function describe(option: HardwareOption): string {
  const need = option.device === "directMl"
    ? ` · 显存约 ${gb(option.vramNeed)}`
    : option.ramNeed > 0 ? ` · 内存约 ${gb(option.ramNeed)}` : "";
  return `${DEVICE_NAME[option.device]}${need} · ${option.downloaded ? "已下载" : `需下载 ${mb(option.size)}`}`;
}

/** 选“自动”时，说明实际在用的档。 */
function automatic(status: TaggingStatus | null): string {
  if (status?.state === "running" || status?.state === "idle") {
    return status.device === "directMl"
      ? `自动：当前用显卡${status.gpu ? `（${status.gpu}）` : ""}`
      : "自动：当前用 CPU";
  }
  if (status?.state === "needsDownload" && status.fallback !== null) return "自动：显卡不可用，改用 CPU";
  return "自动：有独显时用显卡";
}

/**
 * 设置 › 自动标签（#143）：打标状态（暂停、继续、下载），Tagger 模型（只读），硬件加速（自动／显卡／CPU），
 * 没有网络时导入模型包。状态跟着后端唯一的可写资料库（ADR-0008），与侧栏卡片同一套处理。
 * 换硬件档后已经打过标的图不重打。
 */
export function AutoTaggingSettings({ libraryId: opened }: { libraryId: string | null }) {
  const { libraryId, status } = useTaggingStatus(opened);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 画师改过选择（换档、导入、下载）的次数：在这之前开始的重新读取晚到时不再采用，免得把刚选的档盖回去。 */
  const changes = useRef(0);

  // 状态变了（例如下载完成、换了档）就重读各档是否已下载。
  const phase = status?.state ?? null;
  useEffect(() => {
    let alive = true;
    const since = changes.current;
    taggingModels().then(
      (value) => alive && value && since === changes.current && setChoice(value),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [phase]);

  async function run(change: () => Promise<ModelChoice | null>, done: string | null) {
    setError(null);
    setMessage(null);
    changes.current += 1;
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

  const selected = choice?.options.find((o) => o.device === choice.selected);
  return <>
    <SettingsGroup title="自动打标">
      <TaggingStatusRow libraryId={libraryId} status={status} />
    </SettingsGroup>
    {choice && <SettingsGroup title="模型">
      <SettingsRow label="Tagger 模型" icon={<Tags size={16} />} title="Tagger 模型" desc="给导入的图加上标签建议">
        <span className="k-set-muted">{choice.model}</span>
      </SettingsRow>
      <SettingsRow label="硬件加速" icon={<Cpu size={16} />} title="硬件加速" desc={selected ? describe(selected) : automatic(status)}>
        <select className="k-select" aria-label="硬件加速" value={choice.selected ?? "auto"}
          onChange={(e) => void run(() => taggingSetDevice(e.target.value === "auto" ? null : e.target.value as Device), null)}>
          <option value="auto">自动</option>
          {choice.options.map((o) => <option key={o.device} value={o.device}>{describe(o)}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label="模型包" icon={<PackageOpen size={16} />} title="模型包" desc={busy ? "正在导入并校验…" : message ?? "没网时从文件导入"}
        below={error !== null && <p className="k-set-error" role="alert">{error}</p>}>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void importPackage()}>导入模型包…</button>
      </SettingsRow>
    </SettingsGroup>}
  </>;
}

/** 打标状态一行：状态文字与对应的操作（暂停、继续、下载）；下载时行下方显示进度条。 */
function TaggingStatusRow({ libraryId, status }: { libraryId: string | null; status: TaggingStatus | null }) {
  const row = (desc: ReactNode, action?: ReactNode, below?: ReactNode) =>
    <SettingsRow label="打标状态" icon={<Sparkles size={16} />} title="打标状态" desc={desc} below={below}>{action}</SettingsRow>;
  if (libraryId === null) return row("添加图库后开始自动打标");
  if (status === null) return row("正在读取…");
  const act = (f: (id: string) => Promise<void>) => () => void f(libraryId).catch(() => {});
  const button = (name: string, f: (id: string) => Promise<void>, primary = false) =>
    <button type="button" className={`k-btn is-sm${primary ? "" : " is-ghost"}`} onClick={act(f)}>{name}</button>;
  const pause = button("暂停", taggingPause);

  switch (status.state) {
    // 加载模型可能要几分钟，子进程已在占用显存：加载与校验阶段同样可以暂停（#77 UI-C）。
    case "starting":
    case "preparing":
      return row("正在加载模型…", pause);
    case "running":
      return row(`正在打标 · ${DEVICE_NAME[status.device]} · 已打 ${status.tagged} 张`, pause);
    case "paused":
      return row("已暂停", button("继续", taggingResume));
    case "idle":
      return row("已全部打完");
    case "needsDownload": {
      const need = status.fallback === null
        ? `需要下载模型（${mb(status.size)}）`
        : `显卡不可用：${status.fallback}，改用 CPU 需下载 ${mb(status.size)}`;
      const label = status.downloaded > 0 ? `继续下载（已下载 ${percent(status.downloaded, status.size)}%）` : "下载";
      return row(need, button(label, taggingDownload, true));
    }
    case "downloading": {
      const done = percent(status.downloaded, status.total);
      return row(`正在下载模型 ${done}%（${mb(status.downloaded)} / ${mb(status.total)}）`, undefined,
        <progress className="k-task-progress" max={100} value={done} aria-label="下载进度" aria-valuenow={done} />);
    }
    case "noDevice":
      return row(`自动标签不可用：${status.reason}`);
    case "failed":
      return row(`出错了：${status.reason}。稍后会自动重试`);
  }
}
