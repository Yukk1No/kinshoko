import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Rss } from "lucide-react";
import type { accountActions } from "./accountActions";
import { EmptyState } from "../ui/EmptyState";

type Props = {
  signingIn: boolean;
  actions: ReturnType<typeof accountActions>;
  setFirstRun: (open: boolean) => void;
};

/** 订阅页还没登录 pixiv 时的整页空状态：登录，或先看风险说明；登录窗口开着时等它。 */
export function SubscriptionsEmpty({ signingIn, actions, setFirstRun }: Props) {
  const { t } = useTranslation("subscriptions");
  return (
    <EmptyState
      size="page"
      headingAs="h1"
      title={t(signingIn ? "empty.waitingTitle" : "empty.signedOutTitle")}
      icon={signingIn ? <LoaderCircle className="k-spinner is-accent" /> : <Rss strokeWidth={1.75} />}
      hint={signingIn ? undefined : t("empty.signedOutHint")}
      actions={
        signingIn ? (
          <Fragment key="signing-in">
            <button type="button" className="k-btn is-quiet" onClick={actions.cancel}>
              <span className="k-label">{t("empty.cancel")}</span>
            </button>
            <button type="button" className="k-btn" onClick={actions.signIn}>
              <span className="k-label">{t("empty.backToWindow")}</span>
            </button>
          </Fragment>
        ) : (
          <Fragment key="signed-out">
            <button type="button" className="k-btn" onClick={() => setFirstRun(true)}>
              <span className="k-label">{t("account.risks")}</span>
            </button>
            <button type="button" className="k-btn is-primary" onClick={actions.signIn}>
              <span className="k-label">{t("empty.signIn")}</span>
            </button>
          </Fragment>
        )
      }
    />
  );
}
