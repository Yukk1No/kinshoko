// 导入栏右下角的询问卡：Eagle 库疑似换了位置、选中的路径里有图库备份。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArchiveRestore, MapPinned } from "lucide-react";
import type { EagleLocationChoice } from "../bindings/EagleLocationChoice";
import type { EagleRelocation } from "../bindings/EagleRelocation";
import { i18n } from "../i18n/instance";
import { pickFolder, restoreBackupFolder } from "../ipc";
import { errorText } from "../ipc/commandError";
import { Tip } from "../ui/Tip";
import { useToast } from "../ui/Toast";

export function RelocationCard({
  relocation,
  busy,
  onConfirm,
}: {
  relocation: EagleRelocation;
  busy: boolean;
  onConfirm: (choice: EagleLocationChoice) => void;
}) {
  const { t } = useTranslation("importing");
  return (
    <section className="k-task" role="alert" aria-label={t("relocation.title")}>
      <div className="k-task-top">
        <MapPinned size={16} className="k-task-icon" aria-hidden="true" />
        <b>{t("relocation.title")}</b>
      </div>
      <p className="k-task-sub">{t("relocation.overlap", { percent: relocation.overlapPercent })}</p>
      <p className="k-task-sub import-report-path">{t("relocation.to", { path: relocation.to })}</p>
      <p className="k-task-sub import-report-path">{t("relocation.from", { path: relocation.from })}</p>
      <div className="k-task-acts">
        <button
          type="button"
          className="k-btn is-sm"
          disabled={busy}
          onClick={() => onConfirm({ kind: "moved", sourceId: relocation.sourceId })}
        >
          <span className="k-label">{t("relocation.same")}</span>
        </button>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => onConfirm({ kind: "separate" })}>
          <span className="k-label">{t("relocation.separate")}</span>
        </button>
      </div>
    </section>
  );
}

/** 选中的路径里认出的图库备份：不当散图导入；“恢复…”选好位置后把最新的完整快照恢复成新图库。 */
export function BackupCards({ paths, onDone }: { paths: string[]; onDone: (path: string) => void }) {
  const { t } = useTranslation("importing");
  const toast = useToast();
  const [restoring, setRestoring] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const restore = async (path: string) => {
    const into = await pickFolder();
    if (!into || !alive.current) return;
    setRestoring(path);
    try {
      const restored = await restoreBackupFolder(path, into);
      if (!alive.current) return;
      onDone(path);
      const libraries = restored.libraries.map((l) => l.library.name).join(i18n.t("backup:separator"));
      toast.show({ title: t("backup.restored", { libraries }) });
    } catch (error) {
      if (alive.current) toast.error(t("failed.restore", { error: errorText(error) }));
    } finally {
      if (alive.current) setRestoring(null);
    }
  };
  return paths.map((path) => (
    <section key={path} className="k-task" role="alert" aria-label={t("backup.title")}>
      <div className="k-task-top">
        <ArchiveRestore size={16} className="k-task-icon" aria-hidden="true" />
        <b>{t("backup.title")}</b>
      </div>
      <p className="k-task-sub import-report-path">{path}</p>
      <div className="k-task-acts">
        <Tip label={t("backup.hint")} side="top">
          <button
            type="button"
            className="k-btn is-sm"
            disabled={restoring !== null}
            onClick={() => void restore(path)}
          >
            <span className="k-label">{restoring === path ? t("backup.busy") : t("backup.restore")}</span>
          </button>
        </Tip>
        <button
          type="button"
          className="k-btn is-sm is-ghost"
          disabled={restoring === path}
          onClick={() => onDone(path)}
        >
          <span className="k-label">{t("backup.dismiss")}</span>
        </button>
      </div>
    </section>
  ));
}
