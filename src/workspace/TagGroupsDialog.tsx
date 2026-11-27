import { useTranslation } from "react-i18next";
import { TagGroupsPane } from "../library/TagGroupsPane";
import { DialogShell } from "../ui/DialogShell";

/** 分组编辑器从侧栏移到标签栏的“编辑分组”（#98）。 */
export function TagGroupsDialog({
  open,
  onOpenChange,
  safe,
  generation,
  onBrowse,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  safe: boolean;
  generation: number;
  onBrowse: (globalIds: string[]) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation("search", { keyPrefix: "groups" });
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      purpose="info"
      title={t("dialogTitle")}
      closeLabel={t("close")}
      className="k-groups-dialog"
      footer={
        <>
          <span className="k-grow" />
          <button type="button" className="k-btn is-primary" onClick={() => onOpenChange(false)}>
            <span className="k-label">{t("done")}</span>
          </button>
        </>
      }
    >
      <TagGroupsPane safe={safe} generation={generation} onBrowse={onBrowse} onError={onError} />
    </DialogShell>
  );
}
