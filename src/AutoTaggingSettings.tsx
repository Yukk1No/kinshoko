import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cpu, PackageOpen, Sparkles, Tags } from "lucide-react";
import type { Device } from "./bindings/Device";
import type { HardwareOption } from "./bindings/HardwareOption";
import type { ModelChoice } from "./bindings/ModelChoice";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { SettingsGroup, SettingsRow } from "./ui/SettingsList";
import { importModelPackage, pickModelPackage, taggingCancelDownload, taggingDownload, taggingModels, taggingPause, taggingResume, taggingSetDevice } from "./ipc";
import { useTaggingStatus } from "./useTaggingStatus";
import { Select } from "./ui/Select";
import { i18n } from "./i18n/instance";
import { useTranslation } from "react-i18next";

const gb = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
const percent = (part: number, total: number) => (total > 0 ? Math.floor((part / total) * 100) : 0);
const t = i18n.getFixedT(null, "tagging", "settings");
const deviceName = (device: Device) => i18n.t(`tagging:device.${device}`);

/** 一个硬件档：名称 · 显存或内存需求 · 是否已下载。不写精度（FP16/FP32 随档位定，画师不用管）。 */
function describe(option: HardwareOption): string {
  const need = option.device === "directMl"
    ? t("vram", { size: gb(option.vramNeed) })
    : option.ramNeed > 0 ? t("ram", { size: gb(option.ramNeed) }) : "";
  return t("option", { device: deviceName(option.device), need, state: option.downloaded ? t("downloaded") : t("needsDownload", { size: mb(option.size) }) });
}

/** 选“自动”时，说明实际在用的档。 */
function automatic(status: TaggingStatus | null): string {
  if (status?.state === "running" || status?.state === "idle") {
    return status.device === "directMl"
      ? status.gpu ? t("autoGpuNamed", { gpu: status.gpu }) : t("autoGpu")
      : t("autoCpu");
  }
  if (status?.state === "needsDownload" && status.fallback !== null) return t("autoFallback");
  return t("autoDefault");
}

/**
 * 设置 › 自动标签（#143）：打标状态（暂停、继续、下载），Tagger 模型（只读），硬件加速（自动／显卡／CPU），
 * 没有网络时导入模型包。状态跟着后端唯一的可写资料库（ADR-0008），与侧栏卡片同一套处理。
 * 换硬件档后已经打过标的图不重打。
 */
export function AutoTaggingSettings({ libraryId: opened }: { libraryId: string | null }) {
  // 随界面语言重新渲染（文案经 `t` 取，不在组件里订阅）。
  useTranslation("tagging");
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
    await run(() => importModelPackage(path), t("packageImported"));
    setBusy(false);
  }

  const selected = choice?.options.find((o) => o.device === choice.selected);
  return <>
    <SettingsGroup label={t("group")}>
      <TaggingStatusRow libraryId={libraryId} status={status} />
    </SettingsGroup>
    {choice && <SettingsGroup label={t("modelGroup")}>
      <SettingsRow label={t("model")} icon={<Tags size={16} />} title={t("model")} hint={t("modelHint")}>
        <span className="k-set-muted">{choice.model}</span>
      </SettingsRow>
      <SettingsRow label={t("hardware")} icon={<Cpu size={16} />} title={t("hardware")} meta={selected ? describe(selected) : automatic(status)}>
        <Select label={t("hardware")} value={choice.selected ?? "auto"}
          onChange={(value) => void run(() => taggingSetDevice(value === "auto" ? null : value as Device), null)}
          options={[{ value: "auto", label: t("auto") }, ...choice.options.map((o) => ({ value: o.device, label: describe(o) }))]} />
      </SettingsRow>
      <SettingsRow label={t("package")} icon={<PackageOpen size={16} />} title={t("package")} hint={t("packageHint")} meta={busy ? t("importing") : message ?? undefined}
        below={error !== null && <p className="k-set-error" role="alert">{error}</p>}>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void importPackage()}><span className="k-label">{t("importPackage")}</span></button>
      </SettingsRow>
    </SettingsGroup>}
  </>;
}

/** 打标状态一行：状态文字与对应的操作（暂停、继续、下载、取消下载）；下载时行下方显示进度条。 */
function TaggingStatusRow({ libraryId, status }: { libraryId: string | null; status: TaggingStatus | null }) {
  const row = (desc: ReactNode, action?: ReactNode, below?: ReactNode) =>
    <SettingsRow label={t("status")} icon={<Sparkles size={16} />} title={t("status")} meta={desc} below={below}>{action}</SettingsRow>;
  if (libraryId === null) return row(t("noLibrary"));
  if (status === null) return row(t("loading"));
  const act = (f: (id: string) => Promise<void>) => () => void f(libraryId).catch(() => {});
  const button = (name: string, f: (id: string) => Promise<void>, primary = false) =>
    <button type="button" className={`k-btn is-sm${primary ? "" : " is-ghost"}`} onClick={act(f)}><span className="k-label">{name}</span></button>;
  const pause = button(t("pause"), taggingPause);

  switch (status.state) {
    // 加载模型可能要几分钟，子进程已在占用显存：加载与校验阶段同样可以暂停（#77 UI-C）。
    case "starting":
    case "preparing":
      return row(t("loadingModel"), pause);
    case "running":
      return row(t("running", { count: status.tagged, device: deviceName(status.device) }), pause);
    case "paused":
      return row(t("paused"), button(t("resume"), taggingResume));
    // 有全屏程序（游戏）或演示模式时自动让出显卡（#212），不是卡住或出错。系统的通知状态报告不了
    // Windows 设置里的“请勿打扰”开关，所以不提它。
    case "yieldedToFullScreen":
      return row(t("yielded"), pause);
    case "idle":
      return row(t("idle"));
    case "needsDownload": {
      const need = status.fallback === null
        ? t("needsModel", { size: mb(status.size) })
        : t("fallback", { reason: status.fallback, size: mb(status.size) });
      const label = status.downloaded > 0 ? t("resumeDownload", { percent: percent(status.downloaded, status.size) }) : t("download");
      return row(need, button(label, taggingDownload, true));
    }
    case "downloading": {
      const done = percent(status.downloaded, status.total);
      // 暂停与取消都保留已下的部分，之后从断点续传（#213）。
      return row(t("downloading", { percent: done, done: mb(status.downloaded), total: mb(status.total) }), <>{pause}{button(t("cancelDownload"), taggingCancelDownload)}</>,
        <progress className="k-task-progress" max={100} value={done} aria-label={t("progress")} aria-valuenow={done} />);
    }
    case "noDevice":
      return row(t("unavailable", { reason: status.reason }));
    case "failed":
      return row(t("failed", { reason: status.reason }));
  }
}
