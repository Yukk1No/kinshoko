import { Dialog } from "@base-ui/react/dialog";
import { Clock, Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UnofficialMark } from "./UnofficialMark";

const SEEN_KEY = "kinshoko.subscriptions.firstRunSeen";

/** 首次使用说明看过没有（本机记一下；读不到时当作没看过，再说明一次也无妨）。 */
export function firstRunSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; }
}

export function markFirstRunSeen() {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* 记不下就下次再说明 */ }
}

/**
 * 首次使用说明（#366 账号风险）：第一次打开订阅页、还没登录时弹出；之后从“风险说明”再看。
 * 没登录时两个按钮“以后再说 / 知道了，去登录”，已登录时只有“知道了”。
 */
export function FirstRunDialog({ open, signedIn, onClose, onSignIn }: {
  open: boolean; signedIn: boolean; onClose: () => void; onSignIn: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const points = [
    { icon: <Info size={16} strokeWidth={1.75} />, title: t("firstRun.unofficialTitle"), body: t("firstRun.unofficialBody") },
    { icon: <TriangleAlert size={16} strokeWidth={2} />, title: t("firstRun.accountTitle"), body: t("firstRun.accountBody"), warn: true },
    { icon: <Clock size={16} strokeWidth={1.75} />, title: t("firstRun.gentleTitle"), body: t("firstRun.gentleBody") },
  ];
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog subs-first-run">
        <div className="subs-first-run-head">
          <Dialog.Title className="k-dialog-title">{t("firstRun.title")}</Dialog.Title>
          <UnofficialMark />
        </div>
        <Dialog.Description className="k-dialog-desc">{t("firstRun.lead")}</Dialog.Description>
        <ul className="subs-first-run-points">
          {points.map((p) => <li key={p.title} className={p.warn ? "is-warn" : undefined}>
            <span className="subs-first-run-icon" aria-hidden="true">{p.icon}</span>
            <div><p className="subs-first-run-title">{p.title}</p><p className="subs-first-run-body">{p.body}</p></div>
          </li>)}
        </ul>
        <div className="k-dialog-foot">
          {signedIn
            ? <button type="button" className="k-btn is-primary" onClick={onClose}><span className="k-label">{t("firstRun.close")}</span></button>
            : <>
              <button type="button" className="k-btn" onClick={onClose}><span className="k-label">{t("firstRun.later")}</span></button>
              <button type="button" className="k-btn is-primary" onClick={onSignIn}><span className="k-label">{t("firstRun.signIn")}</span></button>
            </>}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
