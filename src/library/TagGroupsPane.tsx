import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, } from "lucide-react";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import { createSharedTagGroup, deleteSharedTagGroup, editSharedTagGroup, restoreSharedTagGroup, sharedTagGroups, isLensChanged } from "../ipc";
import { type Lens } from "../search/SearchBox";
import { useUiLang } from "../i18n";
import { useToast } from "../ui/Toast";

type Props = {
  /** Kept for callers from the previous local UI; group ownership is always application-wide. */
  libraryId?: string;
  safe: boolean;
  generation: number;
  label?: string;
  onBrowse?: (tagIds: string[]) => void;
  onError: (error: unknown) => void;
};

import { NewGroup, } from "./TagGroupsRows";
import { GroupRow } from "./TagGroupsRow";

export { NewGroup };

/** Reuses the formal sidebar editor and the accepted prototype's tag-chip structure.
 * Shared IDs are already query identities. Group actions never edit an image's tags. */
export function TagGroupsPane({ safe, generation, onBrowse, onError, label: labelProp }: Props) {
  const { t } = useTranslation("tagGroups");
  const label = labelProp ?? t("label");
  const [found, setFound] = useState<{ key: string; safe: boolean | null; groups: CatalogGroupView[] }>({ key: "", safe: null, groups: [] });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const view = JSON.stringify([safe, generation]);
  const lang = useUiLang();
  const key = JSON.stringify([view, refresh, lang]);
  const current = useRef(key); current.current = key;
  // Preserve editor identity during refresh, but never display stale server labels or members.
  const groups = found.safe === safe ? found.groups : [];
  const fresh = found.key === key;
  const busy = pendingKey === key;
  const lens: Lens = { libraryId: "workspace", safe, generation, workspace: true };

  useEffect(() => {
    let alive = true;
    sharedTagGroups(lang, safe).then(
      (value) => { if (alive && current.current === key) setFound({ key, safe, groups: value }); },
      (error) => { if (alive && current.current === key && !isLensChanged(error)) onError(error); },
    );
    return () => { alive = false; };
  }, [key, safe, onError, lang]);
  // 切换安全模式时收起正在进行的编辑；读到新的分组后，清掉已不存在的分组上的编辑。
  // 都在渲染中比较，这一帧就不显示旧的编辑。
  const [editingUnder, setEditingUnder] = useState(safe);
  if (editingUnder !== safe) {
    setEditingUnder(safe);
    setCreating(false); setRenaming(null); setPicking(null);
  }
  const gone = (id: string | null) => fresh && id !== null && !groups.some((group) => group.id === id);
  if (gone(renaming)) setRenaming(null);
  if (gone(picking)) setPicking(null);
  // 操作期间按钮被禁用、刷新时行会重建，焦点会丢到页面上。记下焦点所在操作（data-focus-key），
  // 刷新完成后按同一键找回；该操作已不存在或不可用时，依次退到同成员或同分组的其他操作。
  const section = useRef<HTMLElement>(null);
  const restore = useRef<string | null>(null);
  const remember = (fallback?: string) => {
    const active = document.activeElement as HTMLElement | null;
    const focused = active && section.current?.contains(active) ? active.dataset.focusKey : undefined;
    restore.current = focused ?? fallback ?? restore.current;
  };
  // Layout effect: focus returns in the same commit that remounts the rows, before paint.
  // biome-ignore lint/correctness/useExhaustiveDependencies(groups): 行重建后再找回焦点
  useLayoutEffect(() => {
    const wanted = restore.current;
    if (!fresh || busy || wanted === null || !section.current) return;
    restore.current = null;
    const parts = wanted.split(":");
    const group = parts[0];
    const chain = [wanted];
    if (parts.length === 3) chain.push(...["prev", "next", "remove", "chip"].map((action) => `${group}:${parts[1]}:${action}`));
    else chain.push(`${group}:up`, `${group}:down`);
    chain.push(`${group}:name`, `${group}:rename`, "new");
    const targets = [...section.current.querySelectorAll<HTMLButtonElement>("[data-focus-key]")];
    for (const candidate of chain) {
      const target = targets.find((element) => element.dataset.focusKey === candidate);
      if (target && !target.disabled) { target.focus(); return; }
    }
  }, [fresh, busy, groups]);
  const run = async (action: Promise<unknown>, focus?: string) => {
    // 明确指定了焦点去处（如删除分组后的相邻分组）就用它，不取当前聚焦的按钮：那个按钮随行消失。
    if (focus !== undefined) restore.current = focus; else remember();
    setPendingKey(key);
    try {
      await action;
      if (current.current === key) setRefresh((n) => n + 1);
    } catch (error) {
      if (current.current === key) onError(error);
    } finally { setPendingKey((pending) => pending === key ? null : pending); }
  };
  const edit = (action: CatalogGroupEdit) => run(editSharedTagGroup(action, safe));
  const toast = useToast();
  /** 删除分组能撤销，所以不先确认：直接删，再给一个带“撤销”的轻提示；撤销用的是删除时返回的内容。 */
  const remove = (group: CatalogGroupView) => {
    // 删掉的分组没有可回的位置：回到相邻分组，没有时回到“新建分组”。
    const at = groups.findIndex((g) => g.id === group.id), next = groups[at + 1] ?? groups[at - 1];
    void run(deleteSharedTagGroup(group.id, safe).then((deleted) => {
      toast.show({
        title: t("deleted.done"), description: group.name, tone: "success",
        action: { label: t("deleted.undo"), onClick: () => { void restoreSharedTagGroup(deleted).then(() => setRefresh((n) => n + 1), onError); } },
      });
    }), next ? `${next.id}:name` : "new");
  };
  // 设计系统 SettingsList 的外框：每个分组一行，28 px 图标方块、名称、靠右的成员数（命名空间分组是胶囊）；
  // 悬停或键盘聚焦时露出改名、上移、下移、删除。成员是 TagChip，悬停露出前移、后移、移出，末尾是幽灵按钮“加标签”。
  // 末行是“新建分组”。删除不先确认，轻提示带“撤销”（#479）。
  return (
    <section ref={section} className="sidebar-tag-groups k-groups" aria-label={label} aria-busy={busy || !fresh}>
      {!fresh && <p className="k-set-note" role="status">{t("updating")}</p>}
      <div className="k-group-list">
      <div className="k-group-rows">
      {groups.map((group, index) => <GroupRow key={group.id} group={group} index={index} groups={groups} fresh={fresh} busy={busy} renaming={renaming} setRenaming={setRenaming} picking={picking} setPicking={setPicking} onBrowse={onBrowse} edit={edit} remove={remove} remember={remember} section={section} lens={lens} />)}
      </div>
      {creating ? <NewGroup onDone={(group) => {
        setCreating(false);
        remember("new");
        if (group) void run(createSharedTagGroup(group.name, group.namespace));
      }} /> : <button type="button" className="k-group-create" aria-label={t("create.open")} data-focus-key="new" disabled={busy || !fresh} onClick={() => setCreating(true)}>
        <span className="k-group-icon" aria-hidden="true"><Plus size={16} /></span><span className="k-label">{t("create.button")}</span></button>}
      </div>
    </section>
  );
}
