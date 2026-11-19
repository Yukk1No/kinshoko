import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { foldIntoPrevious, onDeskGroupStarted, referenceGroup } from "../ipc";
import { errorText } from "../ipc/commandError";
import { useToast } from "../ui/Toast";
import { groupLabel } from "./groupLabel";

/**
 * 空桌上钉下第一张开了新参考组（#595）：提示“已开新参考组”，带“加进「上一组」”，
 * 把这张连同之后钉的并回上一组。上一组读不出来时只提示，不带这一项。
 */
export function useDeskGroupStarted() {
  const { t } = useTranslation("desktop");
  const toast = useToast();
  useEffect(() => {
    let live = true;
    const unlisten = onDeskGroupStarted((previousId) => {
      void referenceGroup(previousId)
        .then(
          (view) => view.group,
          () => null,
        )
        .then((previous) => {
          if (!live) return;
          toast.show({
            title: t("deskPanel.started"),
            action: previous
              ? {
                  label: t("deskPanel.foldInto", { name: groupLabel(previous) }),
                  onClick: () => void foldIntoPrevious(previousId).catch((e) => toast.error(errorText(e))),
                }
              : undefined,
          });
        });
    });
    return () => {
      live = false;
      void unlisten.then((stop) => stop());
    };
  }, [t, toast]);
}
