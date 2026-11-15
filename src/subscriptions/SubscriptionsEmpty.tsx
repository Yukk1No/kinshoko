import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LoaderCircle, Rss } from "lucide-react";
import { accountActions } from "./accountActions";

// 订阅页没有名单时的空状态，原样从 SubscriptionsPage.tsx 移出。

type Props = {
  signingIn: boolean;
  account: { name: string } | null;
  actions: ReturnType<typeof accountActions>;
  addMenu: (trigger: ReactElement) => ReactElement;
  setFirstRun: (open: boolean) => void;
};

export function SubscriptionsEmpty({ signingIn, account, actions, addMenu, setFirstRun }: Props) {
  const { t } = useTranslation("subscriptions");
  return (
    <div className="subs-empty">
      <span className="subs-empty-icon" aria-hidden="true">
        {signingIn ? <LoaderCircle className="subs-spin is-accent" size={24} /> : <Rss size={24} strokeWidth={1.75} />}
      </span>
      {signingIn ? (
        <>
          <h1 className="subs-empty-title">{t("empty.waitingTitle")}</h1>
          <div className="subs-empty-actions">
            <button type="button" className="k-btn is-quiet" onClick={actions.cancel}>
              <span className="k-label">{t("empty.cancel")}</span>
            </button>
            <button type="button" className="k-btn" onClick={actions.signIn}>
              <span className="k-label">{t("empty.backToWindow")}</span>
            </button>
          </div>
        </>
      ) : account ? (
        <>
          <h1 className="subs-empty-title">{t("empty.noSubsTitle")}</h1>
          <div className="subs-empty-actions">
            {addMenu(
              <button type="button" className="k-btn is-primary">
                <span className="k-label">{t("add")}</span>
                <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
              </button>,
            )}
          </div>
        </>
      ) : (
        <>
          <h1 className="subs-empty-title">{t("empty.signedOutTitle")}</h1>
          <p className="subs-empty-hint">{t("empty.signedOutHint")}</p>
          <div className="subs-empty-actions">
            <button type="button" className="k-btn" onClick={() => setFirstRun(true)}>
              <span className="k-label">{t("account.risks")}</span>
            </button>
            <button type="button" className="k-btn is-primary" onClick={actions.signIn}>
              <span className="k-label">{t("empty.signIn")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
