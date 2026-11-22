import { useState } from "react";
import { ChevronDown, FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Subscription } from "../bindings/Subscription";
import { CreateLibraryDialog, type CreatedLibrary } from "../library/CreateLibrary";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import { Menu, MenuItem, MenuPopup, MenuRadioItem, MenuSeparator } from "../ui/Menu";
import { useSubscriptionsContext } from "./useSubscriptions";

/**
 * 菜单里的“收进哪个图库”：可用的图库一行一个，现在收进的打勾（几条收进不同的库时都不打勾），末尾是“新建图库…”。
 * 放在 `MenuPopup` 或 `MenuSubmenu` 里。
 */
export function LibraryChoices({
  current,
  onPick,
  onCreate,
}: {
  current: string | null;
  onPick: (libraryId: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const { options } = useLibraryOptions();
  return (
    <>
      <Menu.RadioGroup value={current ?? ""} onValueChange={(value) => onPick(String(value))}>
        {options.map((o) => (
          <MenuRadioItem key={o.value} value={o.value}>
            {o.label}
          </MenuRadioItem>
        ))}
      </Menu.RadioGroup>
      <MenuSeparator />
      <MenuItem icon={<FolderPlus size={14} />} onClick={onCreate}>
        {t("browse.newLibrary")}
      </MenuItem>
    </>
  );
}

/** 几条订阅现在都收进的那个库；收进不同的库时为空。 */
export function sharedLibrary(subs: Subscription[]): string | null {
  const first = subs[0]?.libraryId ?? null;
  return subs.every((s) => s.libraryId === first) ? first : null;
}

/**
 * 改几条订阅收进的库，包括新建一个库再改过去。返回给菜单用的 `pick`、`create`，以及要挂在页面上的新建对话框。
 */
export function useLibraryChange(targets: () => Subscription[]) {
  const subs = useSubscriptionsContext();
  const [creating, setCreating] = useState<Subscription[] | null>(null);
  const pick = (libraryId: string) => void subs?.setLibrary(targets(), libraryId);
  const create = () => setCreating(targets());
  const dialog = creating && (
    <CreateLibraryDialog
      onClose={() => setCreating(null)}
      onCreated={(library: CreatedLibrary) => {
        setCreating(null);
        void subs?.setLibrary(creating, library.id, library.name);
      }}
    />
  );
  return { pick, create, dialog };
}

/** 榜单页、我的收藏页开关旁边的“收进「某库」”：点开换库。 */
export function LibraryChip({ subscription }: { subscription: Subscription }) {
  const { t } = useTranslation("subscriptions");
  const subs = useSubscriptionsContext();
  const { options } = useLibraryOptions();
  const change = useLibraryChange(() => [subscription]);
  const library = options.find((o) => o.value === subscription.libraryId)?.label;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="k-btn is-sm pw-library-chip"
          disabled={!!subs?.pending("library")}
          aria-label={t("browse.changeLibraryOf", { name: library ?? "" })}
        >
          {library ? (
            <>
              <span className="k-label">{t("browse.savesTo")}</span>
              <span className="k-name">{library}</span>
            </>
          ) : (
            <span className="k-label">{t("browse.savesIntoMissing")}</span>
          )}
          <ChevronDown size={14} aria-hidden="true" />
        </Menu.Trigger>
        <MenuPopup label={t("browse.savesIntoMenu")}>
          <LibraryChoices current={subscription.libraryId} onPick={change.pick} onCreate={change.create} />
        </MenuPopup>
      </Menu.Root>
      {change.dialog}
    </>
  );
}
