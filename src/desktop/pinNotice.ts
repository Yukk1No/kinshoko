// 钉图上的提示（#355）：后端交来 `PinNotice`，这里按界面语言写成一句话。
import { i18n } from "../i18n/instance";
import type { PinNotice } from "../bindings/PinNotice";
import { describeCommandError } from "../ipc/commandError";

export function pinNoticeText(notice: PinNotice): string {
  switch (notice.kind) {
    case "failed":
      return describeCommandError(notice.error);
    case "savedToGroup":
    case "addedToGroup":
      return i18n.t(`pins:notice.${notice.kind}`, { name: notice.name });
    default:
      return i18n.t(`pins:notice.${notice.kind}`);
  }
}
