import { useCallback, useEffect, useState } from "react";
import type { BackupPreview } from "./bindings/BackupPreview";
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
} from "./ipc";

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
    ? `参考组「${u.group.name}」引用的资料库没有登记在本设备上，不在这次备份里`
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
 * 设置里的“备份”一节：备份目录、范围（全部或按库缩小，执行前列出带上的参考组、没覆盖的内容与容量）、
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
    <section className="settings backup-settings" aria-label="备份">
      <h2>备份</h2>
      {plan.target === null ? (
        <p className="settings-hint">还没有选择备份目录。选另一块硬盘或移动盘上的文件夹，每天第一次退出或空闲时自动备份一次。</p>
      ) : (
        <p className="settings-hint">
          备份到 <code>{plan.target}</code>
          {plan.lastSuccess !== null && <>；上次备份：{stampText(plan.lastSuccess)}</>}
        </p>
      )}
      {plan.lastFailure !== null && (
        <p className="settings-error" role="alert">
          上次备份没有完成（{stampText(plan.lastFailure.at)}）：{plan.lastFailure.reason}
        </p>
      )}
      {error !== null && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <p className="settings-actions">
        <button type="button" onClick={() => void choose().catch((e) => setError(String(e)))}>
          选择备份目录…
        </button>
        <button
          type="button"
          disabled={plan.target === null || running !== null}
          onClick={() => void startBackup().catch((e) => setError(String(e)))}
        >
          马上备份
        </button>
        {running !== null && (
          <span role="status">
            正在备份：原图 {running.done}／{running.total}
          </span>
        )}
      </p>
      <fieldset className="backup-scope">
        <legend>范围</legend>
        <label className="settings-row">
          <input type="radio" name="backup-scope" checked={narrowed === null} onChange={() => select({ kind: "all" })} />
          本设备的全部资料库与参考组
        </label>
        <label className="settings-row">
          <input
            type="radio"
            name="backup-scope"
            checked={narrowed !== null}
            onChange={() => select({ kind: "libraries", ids: [], includeLinked: true })}
          />
          只备份所选资料库
        </label>
        {narrowed !== null && (
          <div className="backup-libraries">
            {libraries.map(({ library }) => (
              <label key={library.id} className="settings-row">
                <input
                  type="checkbox"
                  checked={narrowed.ids.includes(library.id)}
                  onChange={(e) => toggleLibrary(library.id, e.currentTarget.checked)}
                />
                {library.name}
              </label>
            ))}
            <label className="settings-row">
              <input
                type="checkbox"
                checked={narrowed.includeLinked}
                onChange={(e) => select({ ...narrowed, includeLinked: e.currentTarget.checked })}
              />
              一起备份参考组还引用的资料库
            </label>
          </div>
        )}
      </fieldset>
      {preview !== null && <PreviewView preview={preview} />}
      <RestoreView onError={setError} />
    </section>
  );
}

function PreviewView({ preview }: { preview: BackupPreview }) {
  const { scope, estimate } = preview;
  return (
    <div className="backup-preview" aria-label="备份范围">
      <p>
        资料库：{scope.libraries.map((l) => l.name).join("、") || "无"}；参考组：
        {scope.groups.map((g) => g.name).join("、") || "无"}
      </p>
      <p>
        约 {mb(estimate.totalBytes)}，这次新写入 {mb(estimate.newBytes)}（新原图 {estimate.newOriginals} 张）
        {!preview.targetAvailable && "。备份目录现在不在，按全部需要复制估计"}
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
function RestoreView({ onError }: { onError: (message: string) => void }) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);

  const list = () => backupSnapshots().then((s) => setSnapshots(s ?? []), (e) => onError(String(e)));

  const restore = async (snapshot: SnapshotSummary) => {
    const into = await pickFolder();
    if (!into) return;
    setBusy(true);
    try {
      setReport(await restoreBackup(snapshot.id, into));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backup-restore">
      <p className="settings-actions">
        <button type="button" onClick={() => void list()}>
          从备份恢复…
        </button>
      </p>
      {snapshots !== null && snapshots.length === 0 && <p className="settings-hint">备份目录里还没有完整的快照。</p>}
      {snapshots !== null && snapshots.length > 0 && (
        <>
          <p className="settings-hint">
            恢复出的是独立的资料库与参考组副本，登记到本设备，不覆盖现在的资料库与参考组。选一个快照，再选放恢复出的资料库的文件夹。
          </p>
          <ul className="backup-snapshots">
            {snapshots.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`恢复 ${stampText(s.createdAt)} 的快照`}
                  onClick={() => void restore(s)}
                >
                  {stampText(s.createdAt)}
                </button>{" "}
                资料库 {s.libraries.map((l) => l.name).join("、") || "无"}，参考组 {s.groups.length} 个
              </li>
            ))}
          </ul>
        </>
      )}
      {busy && <p role="status">正在恢复并运行往返检查…</p>}
      {report !== null && <RestoreResult report={report} />}
    </div>
  );
}

function RestoreResult({ report }: { report: RestoreReport }) {
  const { check } = report;
  const problems = [...check.originals.problems, ...check.curation.problems, ...check.groups.problems];
  return (
    <div className="backup-result" aria-label="往返检查">
      <p role={problems.length === 0 ? "status" : "alert"}>
        {problems.length === 0 ? "往返检查通过" : "往返检查发现问题"}：原图 {check.originals.checked} 张哈希一致、整理信息{" "}
        {check.curation.checked} 张表、参考组 {check.groups.checked} 个
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
        恢复出的资料库：{report.libraries.map((l) => l.library.name).join("、") || "无"}（已登记，可从资料库列表打开）；参考组：
        {report.groups.map((g) => g.name).join("、") || "无"}
      </p>
    </div>
  );
}

/** 自动备份没有完成时的提醒（例如移动盘没插）；下次退出或空闲时再试。 */
export function BackupReminder() {
  const [status] = useBackupStatus();
  const [dismissed, setDismissed] = useState<number | null>(null);
  const failure = status?.plan.lastFailure ?? null;
  if (failure === null || dismissed === failure.at.unixMs) return null;
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
