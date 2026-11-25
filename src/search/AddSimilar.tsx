import { useState } from "react";
import type { ReactElement } from "react";
import type { TagLabel } from "../bindings/TagLabel";
import { Popover } from "@base-ui/react/popover";
import { useTranslation } from "react-i18next";
import { Combobox } from "../ui/Combobox";
import { tagOption } from "./tagOptions";
import { tagName } from "./tagLabel";
import { useCandidateState, type Lens } from "./useCandidates";

/** “＋”：贴着按钮的浮层，按名称或别名从可见标签里挑一个，加为 `to` 的相近标签。Esc 或点别处收起。 */
export function AddSimilar({
  lens,
  to,
  button,
  onPick,
}: {
  lens: Lens;
  to: TagLabel;
  button: ReactElement;
  onPick: (tag: TagLabel) => void;
}) {
  const { t } = useTranslation("search");
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={button} />
      <Popover.Portal>
        <Popover.Positioner className="k-positioner" side="bottom" align="start" sideOffset={8}>
          <Popover.Popup className="k-popup k-add-similar" aria-label={t("add.label")}>
            {open && (
              <AddSimilarPicker
                lens={lens}
                to={to}
                onPick={(tag) => {
                  setOpen(false);
                  onPick(tag);
                }}
                onCancel={() => setOpen(false)}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AddSimilarPicker({
  lens,
  to,
  onPick,
  onCancel,
}: {
  lens: Lens;
  to: TagLabel;
  onPick: (tag: TagLabel) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("search");
  const [text, setText] = useState("");
  const { list: found, ready } = useCandidateState(lens, text, (c) => c.tag.id !== to.id);
  return (
    <>
      <p className="k-section-label">{t("add.prompt", { name: tagName(to) })}</p>
      <Combobox
        label={lens.workspace ? t("add.pickShared") : t("add.pickLibrary")}
        autoFocus
        embedded
        value={text}
        options={found.map((c) => tagOption(c, text))}
        empty={ready && found.length === 0 ? t("add.none") : undefined}
        onValueChange={setText}
        onSelect={(option) => onPick(option.tag)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      />
    </>
  );
}
