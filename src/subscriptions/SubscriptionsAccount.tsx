
import { Name } from "../ui/Name";
import { useTranslation } from "react-i18next";
import { Info, LoaderCircle, LogOut, MoreHorizontal, User } from "lucide-react";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { WarnIcon } from "../ui/WarnIcon";
import { Tip } from "../ui/Tip";
import { accountActions } from "./accountActions";

// 订阅页左栏底部的账号区，原样从 SubscriptionsPage.tsx 移出。

type Props = {
  signingIn: boolean;
  account: { name: string } | null;
  login: SubscriptionStatus["login"];
  actions: ReturnType<typeof accountActions>;
  setFirstRun: (open: boolean) => void;
};

export function SubscriptionsAccount({ signingIn, account, login, actions, setFirstRun }: Props) {
  const { t } = useTranslation("subscriptions");
  return (
      <div className="subs-account">
        {signingIn ? <>
          <span className="subs-avatar is-empty" aria-hidden="true"><LoaderCircle className="subs-spin" size={16} /></span>
          <span className="subs-account-text is-muted">{t("account.signingIn")}</span>
        </> : account ? <>
          <span className="subs-avatar" aria-hidden="true">{account.name.slice(0, 1).toUpperCase()}</span>
          <span className="subs-account-text">
            <Name className="subs-account-name">{account.name}</Name>
            {login.state === "expired"
              ? <span className="subs-account-sub is-warn"><WarnIcon />{t("account.expired")}</span>
              : <span className="subs-account-sub">{t("account.source")}</span>}
          </span>
          {login.state === "expired" && <button type="button" className="k-btn is-primary" onClick={actions.signIn}><span className="k-label">{t("account.signInAgain")}</span></button>}
          <Menu.Root modal={false}>
            <Tip label={t("account.menu")}><Menu.Trigger className="k-icon-btn" aria-label={t("account.menu")}><MoreHorizontal size={16} aria-hidden="true" /></Menu.Trigger></Tip>
            <MenuPopup label={t("account.menu")} width={200} side="top">
              <MenuItem icon={<Info size={16} strokeWidth={1.75} />} onClick={() => setFirstRun(true)}>{t("account.risks")}</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<LogOut size={16} strokeWidth={1.75} />} onClick={actions.signOut}>{t("account.signOut")}</MenuItem>
            </MenuPopup>
          </Menu.Root>
        </> : <>
          <span className="subs-avatar is-empty" aria-hidden="true"><User size={16} strokeWidth={1.75} /></span>
          <span className="subs-account-text is-muted">{t("account.signedOut")}</span>
          <button type="button" className="k-btn" onClick={actions.signIn}><span className="k-label">{t("account.signIn")}</span></button>
        </>}
      </div>
  );
}
