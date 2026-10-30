import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupPreview } from "./bindings/BackupPreview";
import { useToast } from "./ui/Toast";
import type { BackupStatus } from "./bindings/BackupStatus";
import type { LibraryRegistration } from "./bindings/LibraryRegistration";
import type { RestoreReport } from "./bindings/RestoreReport";
import type { ScopeSelection } from "./bindings/ScopeSelection";
import type { SnapshotSummary } from "./bindings/SnapshotSummary";
import type { Stamp } from "./bindings/Stamp";
import type { Uncovered } from "./bindings/Uncovered";
import {
  backupPreview,
  backupSnapshots,
  backupStatus,
  onBackupStatus,
  pickFolder,
  registeredLibraries,
  restoreBackup,
  setBackupSelection,
  setBackupTarget,
  startBackup,
  errorText,
} from "./ipc";
import { Archive, CircleCheck, HardDrive, Library, RotateCcw } from "lucide-react";
import { SettingsGroup, SettingsRow, StatusPill } from "./ui/SettingsList";
import { Select } from "./ui/Select";

/** 本地日期时间，按记录时的时区偏移，例如“2026-10-05 08:00”。 */
export function stampText(s: Stamp): string {
  const d = new Date(s.unixMs + s.offsetMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function uncoveredText(u: Uncovered): string {
  if (u.kind === "unreadableGroup") return `参考组「${u.group.name}」读不懂，无法备份：${u.problem}`;
  return u.libraryName === null
    ? `参考组「${u.group.name}」引用的图库没在本机打开，不在这次备份里`
    : `参考组「${u.group.name}」引用的「${u.libraryName}」不在这次备份里`;
}

/** 备份状态：先读一次，之后跟随 `backup-status` 推送。 */
function useBackupStatus(): [BackupStatus | null, (s: BackupStatus) => void] {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  useEffect(() => {
    let alive = true;
    backupStatus().then(
      (s) => {
        if (alive && s) setStatus(s);
      },
      () => {},
    );
    const unlisten = onBackupStatus((s) => alive && setStatus(s));
    return () => {
      alive = false;
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
  return [status, setStatus];
}

/**
 * 设置 › 备份 › 图库（原“资料库备份”）：备份目录、范围（全部或按库缩小，执行前列出带上的参考组、没覆盖的内容与容量）、
 * 上次结果、马上备份，以及从快照恢复（恢复后显示往返检查结果）。
 */
export function BackupSettings() {
  const [status, setStatus] = useBackupStatus();
  const [libraries, setLibraries] = useState<LibraryRegistration[]>([]);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    registeredLibraries().then((l) => setLibraries(l ?? []), () => {});
  }, []);

  const selection = status?.plan.selection;
  const selectionKey = JSON.stringify(selection ?? null);
  useEffect(() => {
    if (!selection) return;
    let alive = true;
    backupPreview(selection).then(
      (p) => {
        if (alive && p) setPreview(p);
      },
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
    // 按范围的内容（不是对象身份）与备份目录重新估计。
  }, [selectionKey, status?.plan.target]);

  const apply = useCallback(
    async (change: Promise<BackupStatus>) => {
      try {
        setStatus(await change);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [setStatus],
  );

  if (status === null) return null;
  const { plan, running } = status;

  const choose = async () => {
    const dir = await pickFolder();
    if (dir) await apply(setBackupTarget(dir));
  };

  const select = (next: ScopeSelection) => void apply(setBackupSelection(next));
  const narrowed = selection?.kind === "libraries" ? selection : null;
  const toggleLibrary = (id: string, on: boolean) => {
    const ids = narrowed?.ids ?? [];
    select({
      kind: "libraries",
      ids: on ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id),
      includeLinked: narrowed?.includeLinked ?? true,
    });
  };

  return (
    <section className="backup-settings" aria-label="图库备份">
      <SettingsGroup label="图库" note="含原图、逐图整理、文件夹、参考组和标签定义；恢复不改当前设置。名称、分组和相近规则在下面的偏好设置里。">
        <SettingsRow icon={<HardDrive size={16} />} title="备份位置"
          meta={plan.target ?? "还没选"} hint="最好放在另一块硬盘" label="备份位置">
          <button type="button" className="k-btn is-sm" onClick={() => void choose().catch((e) => setError(String(e)))}>
            <span className="k-label">{plan.target === null ? "选择…" : "更换"}</span>
          </button>
        </SettingsRow>
        <SettingsRow icon={<Archive size={16} />} title="上次备份" hint="每天第一次退出或空闲时自动备份一次"
          meta={running !== null ? <span role="status">正在备份：原图 {running.done}／{running.total}</span>
            : plan.lastSuccess !== null ? stampText(plan.lastSuccess) : "还没有备份"}
          warn={plan.lastFailure !== null && <span role="alert">没有完成（{stampText(plan.lastFailure.at)}）：{plan.lastFailure.reason}</span>}>
          {plan.lastFailure === null && plan.lastSuccess !== null && running === null && <StatusPill tone="ok" icon={<CircleCheck size={12} aria-hidden="true" />}>已备份</StatusPill>}
          <button type="button" className="k-btn is-sm is-primary" disabled={plan.target === null || running !== null}
            onClick={() => void startBackup().catch((e) => setError(String(e)))}><span className="k-label">立即备份</span></button>
        </SettingsRow>
        <SettingsRow icon={<Library size={16} />} title="备份范围"
          meta={preview ? `约 ${mb(preview.estimate.totalBytes)}` : "正在估算…"}
          below={<>
            {narrowed !== null && <div className="backup-libraries" role="group" aria-label="要备份的图库">
              {libraries.map(({ library }) => (
                <label key={library.id} className="k-check">
                  <input type="checkbox" checked={narrowed.ids.includes(library.id)}
                    onChange={(e) => toggleLibrary(library.id, e.currentTarget.checked)} />
                  {library.name}
                </label>
              ))}
              <label className="k-check">
                <input type="checkbox" checked={narrowed.includeLinked}
                  onChange={(e) => select({ ...narrowed, includeLinked: e.currentTarget.checked })} />
                带上参考组引用的图库
              </label>
            </div>}
            {preview !== null && <PreviewView preview={preview} />}
          </>}>
          <Select label="备份范围" value={narrowed === null ? "all" : "libraries"}
            onChange={(value) => select(value === "all" ? { kind: "all" } : { kind: "libraries", ids: [], includeLinked: true })}
            options={[{ value: "all", label: "全部图库" }, { value: "libraries", label: "所选图库" }]} />
        </SettingsRow>
        <RestoreView onError={(e) => setError(errorText(e))} />
      </SettingsGroup>
      {error !== null && <p className="k-set-error" role="alert">{error}</p>}
    </section>
  );
}

function PreviewView({ preview }: { preview: BackupPreview }) {
  const { scope, estimate } = preview;
  return (
    <div className="backup-preview" aria-label="备份内容">
      <p>
        图库：{scope.libraries.map((l) => l.name).join("、") || "无"}；参考组：
        {scope.groups.map((g) => g.name).join("、") || "无"}
      </p>
      <p>
        共约 {mb(estimate.totalBytes)}，这次新写入 {mb(estimate.newBytes)}（新原图 {estimate.newOriginals} 张）
        {!preview.targetAvailable && "。备份位置现在不在，按全部需要复制估计"}
      </p>
      {(scope.uncovered.length > 0 || estimate.unavailable.length > 0) && (
        <ul className="backup-uncovered" aria-label="没覆盖的内容">
          {scope.uncovered.map((u, i) => (
            <li key={i}>{uncoveredText(u)}</li>
          ))}
          {estimate.unavailable.map((s) => (
            <li key={s.library.id}>
              「{s.library.name}」现在读不到，会跳过：{s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 从快照恢复：列出完整快照，选一个和放恢复出的资料库的文件夹，显示往返检查结果。 */
function RestoreView({ onError }: { onError: (error: unknown) => void }) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);

  const list = () => backupSnapshots().then((s) => setSnapshots(s ?? []), (e) => onError(e));

  const restore = async (snapshot: SnapshotSummary) => {
    const into = await pickFolder();
    if (!into) return;
    setBusy(true);
    try {
      setReport(await restoreBackup(snapshot.id, into));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow icon={<RotateCcw size={16} />} title="恢复图库" hint="恢复为新图库，不覆盖现有" className="backup-restore"
      below={(snapshots !== null || busy || report !== null) && <>
        {snapshots !== null && snapshots.length === 0 && <p className="k-set-note">备份位置里还没有完整的备份。</p>}
        {snapshots !== null && snapshots.length > 0 && <>
          <p className="k-set-note">选一份备份，再选放恢复出的图库的文件夹。恢复出的是独立副本，不覆盖现在的图库与参考组。</p>
          <ul className="backup-snapshots">
            {snapshots.map((s) => (
              <li key={s.id}>
                <button type="button" className="k-btn is-sm" disabled={busy} aria-label={`恢复 ${stampText(s.createdAt)} 的备份`}
                  onClick={() => void restore(s)}><span className="k-label">{stampText(s.createdAt)}</span></button>
                <span>图库 {s.libraries.map((l) => l.name).join("、") || "无"}，参考组 {s.groups.length} 个</span>
              </li>
            ))}
          </ul>
        </>}
        {busy && <p role="status">正在恢复并核对…</p>}
        {report !== null && <RestoreResult report={report} />}
      </>}>
      <button type="button" className="k-btn is-sm" onClick={() => void list()}><span className="k-label">选择备份…</span></button>
    </SettingsRow>
  );
}

function RestoreResult({ report }: { report: RestoreReport }) {
  const { check } = report;
  const problems = [...check.originals.problems, ...check.curation.problems, ...check.groups.problems];
  return (
    <div className="backup-result" aria-label="恢复结果">
      <p role={problems.length === 0 ? "status" : "alert"}>
        <StatusPill tone={problems.length === 0 ? "ok" : "warn"}>{problems.length === 0 ? "完整" : "有问题"}</StatusPill>{" "}
        原图 {check.originals.checked} 张哈希一致、整理信息 {check.curation.checked} 张表、参考组 {check.groups.checked} 个
        {problems.length === 0 ? "一致。" : "已核对。"}
      </p>
      {problems.length > 0 && (
        <ul>
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <p>
        恢复出的图库：{report.libraries.map((l) => l.library.name).join("、") || "无"}（可从图库菜单打开）；参考组：
        {report.groups.map((g) => g.name).join("、") || "无"}
      </p>
    </div>
  );
}

/**
 * 自动备份没有完成时的提醒（例如移动盘没插）；下次退出或空闲时再试。每次失败一条出错轻提示，保持到“知道了”，
 * 之后备份成功或换成新的失败时收起（#388）。没有 ToastProvider 时是窗口里的横幅。
 */
export function BackupReminder() {
  const [status] = useBackupStatus();
  const [dismissed, setDismissed] = useState<number | null>(null);
  const toast = useToast();
  const failure = status?.plan.lastFailure ?? null;
  const shown = useRef<{ at: number; id: string } | null>(null);
  const at = failure?.at.unixMs ?? null, reason = failure?.reason ?? "";
  useEffect(() => {
    if (!toast || shown.current?.at === at) return;
    if (shown.current) toast.close(shown.current.id);
    shown.current = at === null ? null : { at, id: toast.error(`备份没有完成：${reason}`, { description: "Kinshoko 会在下次退出或空闲时再试。" }) };
  }, [toast, at, reason]);
  // 提醒随页面切换重新挂载：卸下时收起自己发出的提示，新实例再发一条，不会越积越多。
  useEffect(() => () => { if (shown.current) toast?.close(shown.current.id); shown.current = null; }, [toast]);
  if (toast || failure === null || dismissed === failure.at.unixMs) return null;
  return (
    <div className="update-banner backup-reminder" role="alert">
      <span>
        备份没有完成：{failure.reason}。Kinshoko 会在下次退出或空闲时再试。
      </span>
      <button type="button" onClick={() => setDismissed(failure.at.unixMs)}>
        知道了
      </button>
    </div>
  );
}
