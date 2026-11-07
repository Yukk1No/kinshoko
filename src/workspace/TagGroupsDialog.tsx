import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TagGroupsPane } from "../library/TagGroupsPane";

/** 分组编辑器从侧栏移到标签栏的“编辑分组”（#98）。 */
export function TagGroupsDialog({ open, onOpenChange, safe, generation, onBrowse, onError }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  safe: boolean;
  generation: number;
  onBrowse: (globalIds: string[]) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation("search", { keyPrefix: "groups" });
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog k-groups-dialog">
          <Dialog.Close className="k-icon-btn k-dialog-x" aria-label={t("close")}><X size={16} aria-hidden="true" /></Dialog.Close>
          <Dialog.Title className="k-dialog-title">{t("dialogTitle")}</Dialog.Title>
          <Dialog.Description className="k-dialog-desc">{t("dialogLead")}</Dialog.Description>
          <TagGroupsPane
            safe={safe}
            generation={generation}
                  onBrowse={onBrowse}
            onError={onError}
          />
          <div className="k-dialog-foot"><span className="k-grow" /><Dialog.Close className="k-btn is-primary"><span className="k-label">{t("done")}</span></Dialog.Close></div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
