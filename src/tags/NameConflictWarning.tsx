import { useTranslation } from "react-i18next";
import type { CatalogTag } from "../bindings/CatalogTag";
import { WarnIcon } from "../ui/WarnIcon";
import { currentName } from "./catalogName";

export function NameConflictWarning({ tag, lang }: { tag: CatalogTag | undefined; lang: string }) {
  const { t } = useTranslation("tags", { keyPrefix: "rename" });
  return tag ? (
    <p className="k-list-desc is-warn" role="status">
      <WarnIcon />
      {t("duplicate", { name: currentName(tag, lang) })}
    </p>
  ) : null;
}
