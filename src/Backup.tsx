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
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n/instance";
import { formatBytes, formatMoment } from "./i18n/format";
import { describeCommandError, storedReasonText } from "./ipc/commandError";

/** 日期时间，按记录时的时区偏移，例如“10月5日 08:00”；不在今年时带年份。 */
export function stampText(s: Stamp): string {
  return formatMoment(s.unixMs, { offsetMinutes: s.offsetMinutes });
}

function uncoveredText(u: Uncovered): string {
  if (u.kind === "unreadableGroup") return i18n.t("backup:uncovered.unreadable", { group: u.group.name, problem: storedReasonText(u.problem) });
  return u.libraryName === null
    ? i18n.t("backup:uncovered.libraryClosed", { group: u.group.name })
    : i18n.t("backup:uncovered.libraryLeftOut", { group: u.group.name, library: u.libraryName });
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
  const { t } = useTranslation("backup");
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
      (e) => alive && setError(errorText(e)),
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
        setError(errorText(e));
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
    <section className="backup-settings" aria-label={t("label")}>
      <SettingsGroup label={t("group")} note={t("groupNote")}>
        <SettingsRow icon={<HardDrive size={16} />} title={t("target")}
          meta={plan.target ?? t("noTarget")} hint={t("targetHint")} label={t("target")}>
          <button type="button" className="k-btn is-sm" onClick={() => void choose().catch((e) => setError(errorText(e)))}>
            <span className="k-label">{plan.target === null ? t("choose") : t("change")}</span>
          </button>
        </SettingsRow>
        <SettingsRow icon={<Archive size={16} />} title={t("last")} hint={t("lastHint")}
          meta={running !== null ? <span role="status">{t("running", { done: running.done, total: running.total })}</span>
            : plan.lastSuccess !== null ? stampText(plan.lastSuccess) : t("never")}
          warn={plan.lastFailure !== null && <span role="alert">{t("failed", { at: stampText(plan.lastFailure.at), reason: storedReasonText(plan.lastFailure.reason) })}</span>}>
          {plan.lastFailure === null && plan.lastSuccess !== null && running === null && <StatusPill tone="ok" icon={<CircleCheck size={12} aria-hidden="true" />}>{t("done")}</StatusPill>}
          <button type="button" className="k-btn is-sm is-primary" disabled={plan.target === null || running !== null}
            onClick={() => void startBackup().catch((e) => setError(errorText(e)))}><span className="k-label">{t("start")}</span></button>
        </SettingsRow>
        <SettingsRow icon={<Library size={16} />} title={t("scope")}
          meta={preview ? t("estimate", { size: formatBytes(preview.estimate.totalBytes) }) : t("estimating")}
          below={<>
            {narrowed !== null && <div className="backup-libraries" role="group" aria-label={t("libraries")}>
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
                {t("includeLinked")}
              </label>
            </div>}
            {preview !== null && <PreviewView preview={preview} />}
          </>}>
          <Select label={t("scope")} value={narrowed === null ? "all" : "libraries"}
            onChange={(value) => select(value === "all" ? { kind: "all" } : { kind: "libraries", ids: [], includeLinked: true })}
            options={[{ value: "all", label: t("all") }, { value: "libraries", label: t("selected") }]} />
        </SettingsRow>
        <RestoreView onError={(e) => setError(errorText(e))} />
      </SettingsGroup>
      {error !== null && <p className="k-set-error" role="alert">{error}</p>}
    </section>
  );
}

function PreviewView({ preview }: { preview: BackupPreview }) {
  const { t } = useTranslation("backup");
  const { scope, estimate } = preview;
  const names = (list: { name: string }[]) => list.map((entry) => entry.name).join(t("separator")) || t("none");
  return (
    <div className="backup-preview" aria-label={t("preview.label")}>
      <p>{t("preview.scope", { libraries: names(scope.libraries), groups: names(scope.groups) })}</p>
      <p>
        {t("preview.size", { total: formatBytes(estimate.totalBytes), fresh: formatBytes(estimate.newBytes), count: estimate.newOriginals })}
        {!preview.targetAvailable && t("preview.targetMissing")}
      </p>
      {(scope.uncovered.length > 0 || estimate.unavailable.length > 0) && (
        <ul className="backup-uncovered" aria-label={t("preview.uncovered")}>
          {scope.uncovered.map((u, i) => (
            <li key={i}>{uncoveredText(u)}</li>
          ))}
          {estimate.unavailable.map((s) => (
            <li key={s.library.id}>
              {t("preview.unavailable", { library: s.library.name, reason: storedReasonText(s.reason) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 从快照恢复：列出完整快照，选一个和放恢复出的资料库的文件夹，显示往返检查结果。 */
function RestoreView({ onError }: { onError: (error: unknown) => void }) {
  const { t } = useTranslation("backup", { keyPrefix: "restore" });
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
    <SettingsRow icon={<RotateCcw size={16} />} title={t("title")} hint={t("hint")} className="backup-restore"
      below={(snapshots !== null || busy || report !== null) && <>
        {snapshots !== null && snapshots.length === 0 && <p className="k-set-note">{t("empty")}</p>}
        {snapshots !== null && snapshots.length > 0 && <>
          <p className="k-set-note">{t("note")}</p>
          <ul className="backup-snapshots">
            {snapshots.map((s) => (
              <li key={s.id}>
                <button type="button" className="k-btn is-sm" disabled={busy} aria-label={t("snapshotLabel", { at: stampText(s.createdAt) })}
                  onClick={() => void restore(s)}><span className="k-label">{stampText(s.createdAt)}</span></button>
                <span>{t("snapshot", { libraries: s.libraries.map((l) => l.name).join(i18n.t("backup:separator")) || i18n.t("backup:none"), count: s.groups.length })}</span>
              </li>
            ))}
          </ul>
        </>}
        {busy && <p role="status">{t("busy")}</p>}
        {report !== null && <RestoreResult report={report} />}
      </>}>
      <button type="button" className="k-btn is-sm" onClick={() => void list()}><span className="k-label">{t("choose")}</span></button>
    </SettingsRow>
  );
}

function RestoreResult({ report }: { report: RestoreReport }) {
  const { t } = useTranslation("backup");
  const { check } = report;
  const names = (list: string[]) => list.join(t("separator")) || t("none");
  const problems = [...check.originals.problems, ...check.curation.problems, ...check.groups.problems];
  return (
    <div className="backup-result" aria-label={t("restore.result")}>
      <p role={problems.length === 0 ? "status" : "alert"}>
        <StatusPill tone={problems.length === 0 ? "ok" : "warn"}>{problems.length === 0 ? t("restore.complete") : t("restore.problems")}</StatusPill>{" "}
        {t("restore.check", { originals: check.originals.checked, curation: check.curation.checked, groups: check.groups.checked })}
        {problems.length === 0 ? t("restore.consistent") : t("restore.checked")}
      </p>
      {problems.length > 0 && (
        <ul>
          {problems.map((p, i) => (
            <li key={i}>{describeCommandError(p)}</li>
          ))}
        </ul>
      )}
      <p>{t("restore.restored", { libraries: names(report.libraries.map((l) => l.library.name)), groups: names(report.groups.map((g) => g.name)) })}</p>
    </div>
  );
}

/**
 * 自动备份没有完成时的提醒（例如移动盘没插）；下次退出或空闲时再试。每次失败一条出错轻提示，保持到“知道了”，
 * 之后备份成功或换成新的失败时收起（#388）。
 */
export function BackupReminder() {
  const [status] = useBackupStatus();
  const toast = useToast();
  const { t } = useTranslation("backup", { keyPrefix: "reminder" });
  const failure = status?.plan.lastFailure ?? null;
  const shown = useRef<{ at: number; id: string } | null>(null);
  const at = failure?.at.unixMs ?? null, reason = failure ? storedReasonText(failure.reason) : "";
  useEffect(() => {
    if (shown.current?.at === at) return;
    if (shown.current) toast.close(shown.current.id);
    shown.current = at === null ? null : { at, id: toast.error(t("title", { reason }), { description: t("retry") }) };
  }, [toast, at, reason]);
  useEffect(() => () => { if (shown.current) toast.close(shown.current.id); shown.current = null; }, [toast]);
  return null;
}
