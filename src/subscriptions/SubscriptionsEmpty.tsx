import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LoaderCircle, Rss } from "lucide-react";
import { accountActions } from "./accountActions";
import { EmptyState } from "../ui/EmptyState";

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
    <EmptyState
      size="page"
      headingAs="h1"
      title={t(signingIn ? "empty.waitingTitle" : account ? "empty.noSubsTitle" : "empty.signedOutTitle")}
      icon={signingIn ? <LoaderCircle className="subs-spin is-accent" /> : <Rss strokeWidth={1.75} />}
      hint={!signingIn && !account ? t("empty.signedOutHint") : undefined}
      actions={
        signingIn ? (
          <>
            <button type="button" className="k-btn is-quiet" onClick={actions.cancel}>
              <span className="k-label">{t("empty.cancel")}</span>
            </button>
            <button type="button" className="k-btn" onClick={actions.signIn}>
              <span className="k-label">{t("empty.backToWindow")}</span>
            </button>
          </>
        ) : account ? (
          <>
            {addMenu(
              <button type="button" className="k-btn is-primary">
                <span className="k-label">{t("add")}</span>
                <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
              </button>,
            )}
          </>
        ) : (
          <>
            <button type="button" className="k-btn" onClick={() => setFirstRun(true)}>
              <span className="k-label">{t("account.risks")}</span>
            </button>
            <button type="button" className="k-btn is-primary" onClick={actions.signIn}>
              <span className="k-label">{t("empty.signIn")}</span>
            </button>
          </>
        )
      }
    />
  );
}
