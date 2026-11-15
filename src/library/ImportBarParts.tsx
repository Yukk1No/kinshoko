import type { SaveDestination } from "../bindings/SaveDestination";
import { useId, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronRight, CircleCheck, CircleSlash, FolderOpen, Images, Library, X } from "lucide-react";
import type { ImportOptions } from "../bindings/ImportOptions";
import type { ImportOutcome } from "../bindings/ImportOutcome";
import type { ImportReport } from "../bindings/ImportReport";
import type { EagleLibraryCandidate } from "../bindings/EagleLibraryCandidate";
import { describeCommandError } from "../ipc/commandError";
import type { FinishedImport, RunningImport } from "./ImportBar";
import { DialogHeight } from "../ui/DialogHeight";
import { WarnIcon } from "../ui/WarnIcon";
import type { ToastOptions } from "../ui/Toast";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n/instance";
import { Tip } from "../ui/Tip";

export type ImportPlan = { paths: string[]; options: ImportOptions; eagle: boolean };
type Begin = (paths: string[], fromEagle?: boolean, options?: ImportOptions, fixed?: SaveDestination) => Promise<void>;

function reason(outcome: ImportOutcome): string | null {
  switch (outcome.kind) {
    case "unsupported":
      return i18n.t("importing:result.unsupported");
    case "readFailed":
      return i18n.t("importing:result.readFailed", { error: describeCommandError(outcome.reason) });
    default:
      return null;
  }
}

function importCounts(report: ImportReport) {
  return {
    imported: report.items.filter((i) => i.outcome.kind === "imported").length,
    merged: report.items.filter((i) => i.outcome.kind === "merged").length,
    refreshed: report.items.filter((i) => i.outcome.kind === "refreshed").length,
    newVersions: report.items.filter((i) => i.outcome.kind === "newVersion").length,
    skippedDeleted: report.items.filter((i) => i.outcome.kind === "skippedDeleted").map((i) => i.path),
    trashDuplicate: report.items.some((i) => i.outcome.kind === "trashDuplicate"),
    rejected: report.items.filter((i) => reason(i.outcome) !== null),
    failed: report.items.filter((i) => i.outcome.kind === "readFailed").map((i) => i.path),
  };
}

/**
 * 导入结束的轻提示（#388）：去向与数字；有要处理的（未导入、删过的图、回收站里的）时带“查看”，打开结果回执卡，
 * 且不自动消失。key 概括内容，用来在数字被收起时原地更新。
 */
export function importNotice(
  report: ImportReport,
  owner: string | null,
  warnings: readonly string[] = [],
): { key: string; toast: (view: () => void, show?: () => void) => Omit<ToastOptions, "onClose"> } {
  const t = i18n.getFixedT(null, "importing", "result");
  const counts = importCounts(report);
  const stats: [string, number, boolean?][] = report.privateSummary
    ? []
    : [
        [t("imported"), counts.imported, true],
        [t("merged"), counts.merged],
        [t("refreshed"), counts.refreshed],
        [t("newVersions"), counts.newVersions],
        [t("eagleMissing"), report.eagleMissing],
      ];
  const shown = stats.filter(([, n, always]) => always || n > 0);
  // 任务警告（如标签定义没存进图库）与封印项重复也要能回到回执里处理。
  const review =
    counts.rejected.length > 0 ||
    counts.skippedDeleted.length > 0 ||
    counts.trashDuplicate ||
    report.trashDuplicates ||
    report.sealedDuplicates ||
    warnings.length > 0;
  const stays = counts.rejected.length > 0 || warnings.length > 0;
  const title = report.cancelled ? t("cancelled") : t("done");
  return {
    key: JSON.stringify([title, owner, report.privateSummary, shown, counts.rejected.length, review, warnings]),
    // 没有要处理的、又进来了图：带“打开”，直接去导入的位置看结果。
    toast: (view, show) => ({
      title,
      tone: report.cancelled ? "info" : "success",
      timeout: stays ? 0 : undefined,
      description: (
        <>
          {owner && <span className="k-toast-line">{i18n.t("importing:ownerLine", { owner })}</span>}
          <span className="k-toast-stats">
            {report.privateSummary && <span>{t("private")}</span>}
            {shown.map(([label, n]) => (
              <span key={label}>
                {label} <b>{t("amount", { count: n })}</b>
              </span>
            ))}
            {counts.rejected.length > 0 && (
              <span className="is-danger">
                {t("rejected")} <b>{t("amount", { count: counts.rejected.length })}</b>
              </span>
            )}
          </span>
          {warnings.map((warning, index) => (
            <span key={index} className="k-toast-line is-warn">
              <WarnIcon />
              {warning}
            </span>
          ))}
        </>
      ),
      action: review
        ? { label: t("view"), onClick: view }
        : show && !report.cancelled && counts.imported + counts.merged + counts.refreshed + counts.newVersions > 0
          ? { label: t("show"), onClick: show }
          : undefined,
    }),
  };
}

/** “未导入 N”这一行，点开是这些文件和原因。 */
function RejectedFiles({ items }: { items: ImportReport["items"] }) {
  const { t } = useTranslation("importing", { keyPrefix: "result" });
  const [open, setOpen] = useState(false);
  const list = useId();
  return (
    <>
      <div className="k-task-stats">
        <button
          type="button"
          className="k-task-toggle is-danger"
          aria-expanded={open}
          aria-controls={list}
          onClick={() => setOpen((value) => !value)}
        >
          <span>
            {t("rejected")} <b>{t("amount", { count: items.length })}</b>
          </span>
          <ChevronRight size={12} aria-hidden="true" />
        </button>
      </div>
      <div id={list} className="k-task-more" hidden={!open}>
        {open && (
          <ul>
            {items.map((item) => (
              <li key={item.path}>
                <span className="import-report-path">{item.path}</span>
                <span className="import-report-reason">{reason(item.outcome)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** 导入结果卡片：新增、已存在与未导入的文件，可只重试读取失败的项。 */
export function ImportResultCard({
  report,
  finished,
  owner,
  taskSwitcher,
  cardNotes,
  busy,
  begin,
  optionsByTask,
  libraryId,
  onOpenTrash,
  onDismissReport,
}: {
  report: ImportReport;
  finished: FinishedImport | null;
  owner: string | null;
  taskSwitcher?: ReactNode;
  cardNotes?: ReactNode;
  busy: boolean;
  begin: Begin;
  optionsByTask: { current: Map<string, ImportOptions> };
  libraryId: string;
  onOpenTrash?: (libraryId: string) => void;
  onDismissReport: () => void;
}) {
  const { t } = useTranslation("importing", { keyPrefix: "result" });
  const counts = importCounts(report);
  return (
    <section className="k-task" aria-label={t("label")}>
      <div className="k-task-top">
        {report.cancelled ? (
          <CircleSlash size={16} className="k-task-icon" aria-hidden="true" />
        ) : (
          <CircleCheck size={16} className="k-task-icon" aria-hidden="true" />
        )}
        <b>{report.cancelled ? t("cancelled") : t("done")}</b>
        <button type="button" className="k-icon-btn is-sm" aria-label={t("close")} onClick={onDismissReport}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {owner && <p className="k-task-sub">{i18n.t("importing:ownerLine", { owner })}</p>}
      {taskSwitcher}
      {report.privateSummary ? (
        <p className="k-task-sub">{t("private")}</p>
      ) : (
        <p className="k-task-stats">
          <span>
            {t("imported")} <b>{t("amount", { count: counts.imported })}</b>
          </span>
          {counts.merged > 0 && (
            <Tip label={t("mergedHint")} side="top">
              <span>
                {t("merged")} <b>{t("amount", { count: counts.merged })}</b>
              </span>
            </Tip>
          )}
          {counts.refreshed > 0 && (
            <Tip label={t("refreshedHint")} side="top">
              <span>
                {t("refreshed")} <b>{t("amount", { count: counts.refreshed })}</b>
              </span>
            </Tip>
          )}
          {counts.newVersions > 0 && (
            <Tip label={t("newVersionsHint")} side="top">
              <span>
                {t("newVersions")} <b>{t("amount", { count: counts.newVersions })}</b>
              </span>
            </Tip>
          )}
          {report.eagleMissing > 0 && (
            <Tip label={t("eagleMissingHint")} side="top">
              <span>
                {t("eagleMissing")} <b>{t("amount", { count: report.eagleMissing })}</b>
              </span>
            </Tip>
          )}
        </p>
      )}
      {counts.rejected.length > 0 && <RejectedFiles key={finished?.taskId} items={counts.rejected} />}
      {cardNotes}
      {counts.skippedDeleted.length > 0 && (
        <p className="k-task-sub">
          {t("skippedDeleted")}
          <button
            type="button"
            className="k-link"
            disabled={busy}
            onClick={() => void begin(counts.skippedDeleted, true, undefined, finished?.destination)}
          >
            {t("importAnyway")}
          </button>
        </p>
      )}
      {(counts.trashDuplicate || report.trashDuplicates) && (
        <p className="k-task-sub">
          {t("inTrash")}
          {onOpenTrash && (
            <button type="button" className="k-link" onClick={() => onOpenTrash?.(finished?.libraryId ?? libraryId)}>
              {t("openTrash")}
            </button>
          )}
        </p>
      )}
      {counts.failed.length > 0 && (
        <div className="k-task-acts">
          <button
            type="button"
            className="k-btn is-sm"
            aria-label={t("retryLabel", { count: counts.failed.length })}
            disabled={busy}
            onClick={() =>
              void begin(
                counts.failed,
                false,
                finished ? optionsByTask.current.get(finished.taskId) : undefined,
                finished?.destination,
              )
            }
          >
            <span className="k-label">{t("retry")}</span>
          </button>
        </div>
      )}
    </section>
  );
}

/** 导入前的确认对话框：来源、保存位置，Eagle 另问删过的图。 */
export function ImportPlanDialog({
  plan,
  setPlan,
  preparing,
  running,
  destinationReady,
  startPlan,
  picker,
}: {
  plan: ImportPlan | null;
  setPlan: Dispatch<SetStateAction<ImportPlan | null>>;
  preparing: boolean;
  running: RunningImport | null;
  destinationReady: boolean;
  startPlan: () => Promise<void>;
  picker?: ReactNode;
}) {
  const { t } = useTranslation("importing", { keyPrefix: "plan" });
  return (
    <Dialog.Root
      open={plan !== null}
      onOpenChange={(open) => {
        if (!open && !preparing) setPlan(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        {/* Popup 留在 Root 下，只让内容随状态出现：卸下 Popup 会让关闭动画等不到结束，遮罩留下盖住窗口（#98 本机 r12）。 */}
        <Dialog.Popup className="k-dialog k-import-dialog">
          {plan && (
            <>
              <Dialog.Title className="k-dialog-title">{plan.eagle ? t("eagleTitle") : t("title")}</Dialog.Title>
              <DialogHeight>
                <div className="k-import-summary">
                  <span className="k-big-tag-icon" aria-hidden="true">
                    {plan.eagle ? <Library size={18} /> : <Images size={18} />}
                  </span>
                  <div className="k-list-text">
                    <div className="k-list-title">
                      {plan.paths.length === 1 ? baseName(plan.paths[0]) : t("paths", { count: plan.paths.length })}
                    </div>
                    <details className="k-task-more">
                      <summary>{t("from")}</summary>
                      <ul>
                        {plan.paths.map((path) => (
                          <li key={path}>
                            <span className="import-report-path">{path}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                </div>
                {picker}
                {plan.eagle && (
                  <fieldset className="k-fieldset" disabled={preparing || !!running}>
                    <legend className="k-field-label">{t("deleted")}</legend>
                    <div className="k-radio-cards">
                      {(
                        [
                          ["skipDeleted", t("skipDeleted"), t("skipDeletedHint")],
                          ["allowThisImport", t("allowThisImport"), t("allowThisImportHint")],
                        ] as const
                      ).map(([value, title, desc]) => (
                        <label
                          key={value}
                          className={`k-radio-card${plan.options.eagleDeletedContent === value ? " is-on" : ""}`}
                        >
                          <input
                            type="radio"
                            name="eagle-deleted-content"
                            checked={plan.options.eagleDeletedContent === value}
                            onChange={() => setPlan({ ...plan, options: { eagleDeletedContent: value } })}
                          />
                          <span>
                            <span className="k-radio-title">{title}</span>
                            <span className="k-radio-desc">{desc}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
              </DialogHeight>
              <div className="k-dialog-foot">
                <span className="k-grow" />
                <button type="button" className="k-btn" disabled={preparing} onClick={() => setPlan(null)}>
                  <span className="k-label">{t("cancel")}</span>
                </button>
                <button
                  type="button"
                  className="k-btn is-primary"
                  disabled={preparing || !!running || !destinationReady}
                  onClick={() => void startPlan()}
                >
                  <span className="k-label">{t("start")}</span>
                </button>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 找到的 Eagle 库，或手动选择。 */
export function EagleLibrariesDialog({
  eagleLibraries,
  setEagleLibraries,
  busy,
  begin,
  importFolder,
}: {
  eagleLibraries: EagleLibraryCandidate[] | null;
  setEagleLibraries: Dispatch<SetStateAction<EagleLibraryCandidate[] | null>>;
  busy: boolean;
  begin: Begin;
  importFolder: (fromEagle?: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("importing", { keyPrefix: "eagle" });
  return (
    <Dialog.Root
      open={eagleLibraries !== null}
      onOpenChange={(open) => {
        if (!open) setEagleLibraries(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog k-import-dialog">
          {eagleLibraries && (
            <>
              <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
              <DialogHeight>
                {eagleLibraries.length ? (
                  <ul className="k-list" aria-label={t("found")}>
                    {eagleLibraries.map((candidate) => (
                      <li key={candidate.path} className="k-list-row">
                        <span className="k-list-icon" aria-hidden="true">
                          <Library size={16} />
                        </span>
                        <div className="k-list-text">
                          <div className="k-list-title">{candidate.name}</div>
                          <Tip label={candidate.path} align="start">
                            <p className="k-list-desc k-parts">
                              <span>{t("items", { count: candidate.items })}</span>
                              {candidate.version && <span>{t("version", { version: candidate.version })}</span>}
                              <span>{candidate.path}</span>
                            </p>
                          </Tip>
                        </div>
                        <div className="k-list-end">
                          <button
                            type="button"
                            className="k-btn is-sm"
                            aria-label={t("importLabel", { name: candidate.name })}
                            disabled={busy}
                            onClick={() => {
                              setEagleLibraries(null);
                              void begin([candidate.path], true);
                            }}
                          >
                            <span className="k-label">{t("import")}</span>
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="k-set-note" role="status">
                    {t("none")}
                  </p>
                )}
              </DialogHeight>
              <div className="k-dialog-foot">
                <button
                  type="button"
                  className="k-btn"
                  disabled={busy}
                  onClick={() => {
                    setEagleLibraries(null);
                    void importFolder(true);
                  }}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  <span className="k-label">{t("manual")}</span>
                </button>
                <span className="k-grow" />
                <button type="button" className="k-btn" onClick={() => setEagleLibraries(null)}>
                  <span className="k-label">{t("cancel")}</span>
                </button>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
