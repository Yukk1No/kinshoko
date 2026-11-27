import { useState, type SyntheticEvent } from "react";
import { Popover } from "@base-ui/react/popover";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "../ui/Tip";
import type { TagLabel } from "../bindings/TagLabel";
import { editTagName } from "../ipc";
import { useUiLang } from "../i18n";
import { nameConflict } from "./nameConflict";
import { NameConflictWarning } from "./NameConflictWarning";
import { useOpenTagNameSettings } from "./TagNameSettings";
import { errorText } from "../ipc/commandError";
import { invalidateTagCatalog, useTagCatalog } from "../library/tagCatalogMirrors";

// 改名框在 portal 里，React 事件仍沿组件树冒泡到外层的标签（它本身是出处浮层的触发器）：在这里截住。
const stop = (event: SyntheticEvent) => event.stopPropagation();
const contained = { onClick: stop, onKeyDown: stop, onPointerDown: stop, onMouseDown: stop, onFocus: stop };

type Props = {
  tag: TagLabel;
  /** 统一标签身份：名称偏好按它保存，所有图库一起生效。 */
  catalogId: string;
  onSaved: () => void;
  onOpenChange?: (open: boolean) => void;
};

/**
 * 尚未翻译标签后的“文/A”按钮（#182）：就地弹框，为统一标签按当前界面语言保存名称偏好，
 * 与 设置 › 标签 › 显示名 的“保存显示名”是同一个动作。和别的标签同名时只提示，不合并身份。
 * 侧栏给已有名称的标签改名（#185）可以复用这个弹框，换掉触发按钮即可。
 */
export function UntranslatedRename({ tag, catalogId, onSaved, onOpenChange }: Props) {
  const { t } = useTranslation("tags", { keyPrefix: "rename" });
  const lang = useUiLang();
  const openSettings = useOpenTagNameSettings();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const catalog = useTagCatalog(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = tag.name;
  const change = (next: boolean) => {
    if (busy && !next) return;
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      setDraft("");
      setError(null);
    }
  };
  // 只为重名提示读目录；读不到时不提示，照样能保存。弹窗关闭就不订阅。
  const others = open ? (catalog.value?.catalog.tags.filter((entry) => entry.id !== catalogId) ?? []) : [];
  const mappings = open ? (catalog.value?.catalog.mappings ?? []) : [];
  const text = draft.trim();
  const duplicate = nameConflict(others, { id: catalogId, namespace: tag.namespace }, text, mappings);
  const save = () => {
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    editTagName(catalogId, { kind: "prefer", name: { lang, name: text } }).then(
      () => {
        invalidateTagCatalog();
        setBusy(false);
        setOpen(false);
        onOpenChange?.(false);
        onSaved();
      },
      (reason) => {
        setBusy(false);
        setError(errorText(reason));
      },
    );
  };
  return (
    <Popover.Root open={open} onOpenChange={change}>
      <Tip label={t("trigger")}>
        <Popover.Trigger className="untranslated is-action" aria-label={t("label", { name })} {...contained}>
          <Languages size={12} aria-hidden="true" />
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Positioner className="k-positioner" side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className="k-popup k-rename" {...contained}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <Popover.Title className="k-rename-title">{t("title", { name })}</Popover.Title>
              <label className="k-field">
                <span className="k-section-label">{t("field")}</span>
                <input
                  className="k-input"
                  autoFocus
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <NameConflictWarning tag={duplicate} lang={lang} />
              <Popover.Description className="k-description is-spaced">{t("hint")}</Popover.Description>
              {error && (
                <p className="k-error-text is-boxed" role="alert">
                  {error}
                </p>
              )}
              <div className="k-rename-acts">
                <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => change(false)}>
                  <span className="k-label">{t("cancel")}</span>
                </button>
                <button type="submit" className="k-btn is-sm is-primary" disabled={busy || !text}>
                  <span className="k-label">{t("save")}</span>
                </button>
              </div>
              {openSettings && (
                <button
                  type="button"
                  className="k-link k-rename-more"
                  onClick={() => {
                    change(false);
                    openSettings(catalogId);
                  }}
                >
                  {t("manage", { name })}
                </button>
              )}
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
