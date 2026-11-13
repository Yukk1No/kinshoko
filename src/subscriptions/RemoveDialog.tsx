import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import type { Subscription } from "../bindings/Subscription";
import { errorText } from "../ipc";
import { subscriptionRemove } from "../ipc/subscriptions";
import { displayName } from "./rankingNames";

/** 退订确认（草图 C）：已收进图库的图留着。 */
export function RemoveDialog({
  subscription,
  onClose,
  onRemoved,
}: {
  subscription: Subscription;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "remove" });
  const { t: ts } = useTranslation("subscriptions");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    setError(null);
    subscriptionRemove(subscription.id).then(
      () => {
        onRemoved();
        onClose();
      },
      (e) => {
        setError(t("failed", { error: errorText(e) }));
        setBusy(false);
      },
    );
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog subs-remove-dialog">
          <Dialog.Title className="k-dialog-title">{t("title", { name: displayName(ts, subscription) })}</Dialog.Title>
          <Dialog.Description className="k-dialog-desc">{t("body")}</Dialog.Description>
          {error && (
            <p className="k-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="k-dialog-foot">
            <span className="k-grow" />
            <button type="button" className="k-btn" disabled={busy} onClick={onClose}>
              <span className="k-label">{t("keep")}</span>
            </button>
            <button type="button" className="k-btn is-danger" disabled={busy} onClick={remove}>
              <span className="k-label">{t("confirm")}</span>
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
