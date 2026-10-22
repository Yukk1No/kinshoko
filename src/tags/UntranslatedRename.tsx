import { useEffect, useState, type SyntheticEvent } from "react";
import { Popover } from "@base-ui/react/popover";
import { Languages } from "lucide-react";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { TagLabel } from "../bindings/TagLabel";
import { editTagName, inspectTagCatalog } from "../ipc";
import { UI_LANG } from "../search/SearchBox";
import { currentName } from "./catalogName";
import { useOpenTagNameSettings } from "./TagNameSettings";

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
  const openSettings = useOpenTagNameSettings();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [others, setOthers] = useState<CatalogTag[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = tag.name;
  const change = (next: boolean) => {
    if (busy && !next) return;
    setOpen(next);
    onOpenChange?.(next);
    if (next) { setDraft(""); setError(null); }
  };
  useEffect(() => {
    if (!open) return;
    let alive = true;
    // 只为重名提示读一次目录；读不到时不提示，照样能保存。
    inspectTagCatalog().then((workspace) => alive && setOthers(workspace.catalog.tags.filter((entry) => entry.id !== catalogId)), () => {});
    return () => { alive = false; };
  }, [open, catalogId]);
  const text = draft.trim();
  const duplicate = text !== "" && others.some((entry) => entry.namespace === tag.namespace && currentName(entry, UI_LANG) === text);
  const save = () => {
    if (!text || busy) return;
    setBusy(true); setError(null);
    editTagName(catalogId, { kind: "prefer", name: { lang: UI_LANG, name: text } }).then(
      () => { setBusy(false); setOpen(false); onOpenChange?.(false); onSaved(); },
      (reason) => { setBusy(false); setError(String(reason)); },
    );
  };
  return (
    <Popover.Root open={open} onOpenChange={change}>
      <Popover.Trigger className="untranslated is-action" aria-label={`给“${name}”改名`} title="尚未翻译 · 点击改名" {...contained}>
        <Languages size={12} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="k-positioner" side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className="k-popup k-rename" {...contained}>
            <form onSubmit={(event) => { event.preventDefault(); save(); }}>
              <Popover.Title className="k-rename-title">给“{name}”改名</Popover.Title>
              <label className="k-field">
                <span className="k-field-label">显示名</span>
                <input className="k-input" autoFocus value={draft} disabled={busy}
                  onChange={(event) => setDraft(event.target.value)} />
              </label>
              {duplicate && <p className="k-list-desc is-warn" role="status">已有标签叫“{text}”，两者仍是不同的标签</p>}
              <Popover.Description className="k-set-note">词表更新不会替换这个名字，可以在设置里恢复默认</Popover.Description>
              {error && <p className="k-set-error" role="alert">{error}</p>}
              <div className="k-rename-acts">
                <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => change(false)}>取消</button>
                <button type="submit" className="k-btn is-sm is-primary" disabled={busy || !text}>保存显示名</button>
              </div>
              {openSettings && <button type="button" className="k-link k-rename-more"
                onClick={() => { change(false); openSettings(catalogId); }}>在设置中管理“{name}”的名称和别名</button>}
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
