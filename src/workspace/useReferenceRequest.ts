import { errorText } from "../ipc/commandError";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { referenceCard } from "../desktop/openInKinshoko";
import { useToast } from "../ui/Toast";
import type { BrowserCard } from "../wall/Wall";
import type { WorkspaceProps } from "./workspaceProps";

/** 钉图菜单“在 Kinshoko 中打开”（#106）：按当前安全模式读这张参考图，读到才交给 `open`（打开查看器）。 */
export function useReferenceRequest(request: WorkspaceProps["referenceRequest"], safe: boolean, open: (card: BrowserCard) => void) {
  const { t } = useTranslation("workspace");
  const toast = useToast();
  useEffect(() => {
    if (!request) return;
    let alive = true;
    const { libraryId: from, imageId } = request;
    referenceCard(from, imageId, safe).then(
      (card) => { if (alive) open(card); },
      (e) => { if (alive) toast.error(t("openFailed", { error: errorText(e) })); },
    );
    return () => { alive = false; };
  }, [request]);
}
