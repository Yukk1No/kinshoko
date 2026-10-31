import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Menu, MenuPopup } from "./Menu";

/* A Kinshoko dock, built from the published behaviour of Arc Pro's dock (uiarc.dev/components/dock):
 * one hairline surface, 40 px slots, a shared selection tint that springs between items, a floating
 * label that glides between items with the shortcut, groups that grow a tray out of the dock, and a
 * short press dip. Springs follow Arc's open motion tokens (MIT, github.com/kuratlielia/arc-library).
 * No Arc Pro code is copied (design/ui-system/README.md, Dock). */
export const arcSpring = {
  snappy: { type: "spring" as const, visualDuration: 0.26, bounce: 0.12 },
  morph: { type: "spring" as const, visualDuration: 0.42, bounce: 0.16 },
  smooth: { type: "spring" as const, visualDuration: 0.4, bounce: 0 },
};

export type DockTrayItem = { id: string; label: string; icon: ReactNode };
export type DockEntry = {
  id: string; label: string; icon: ReactNode; shortcut?: string;
  /** At most one `primary` per dock; `danger` turns red on hover (cancel). */
  tone?: "danger" | "primary"; badge?: number; disabled?: boolean;
  tray?: DockTrayItem[]; trayValue?: string;
  /** Menu items (`MenuItem`s) that open upward from the dock when the item is clicked (#180). */
  menu?: ReactNode; menuWidth?: number;
  /** A second line in the floating label, e.g. why the item is disabled. */
  note?: string;
};
export type DockItem = DockEntry | "sep";

const isEntry = (item: DockItem): item is DockEntry => item !== "sep";

/**
 * `value` marks the selected tool (shared tint). Choosing an item calls `onSelect(id)`; choosing a
 * tray member calls `onSelect(trayOwnerId, memberId)`. Keyboard: ←/→ move, Home/End jump, Enter/Space
 * run, ↑ opens a tray, Esc closes it. A `menu` item opens its menu upward instead of calling `onSelect`. Reduced motion jumps straight to the end state.
 */
export function Dock({ items, value, onSelect, label: labelProp, className = "", readout, tone }: {
  items: DockItem[]; value?: string | null; onSelect: (id: string, member?: string) => void;
  label?: string; className?: string; readout?: ReactNode; tone?: "dark";
}) {
  const { t } = useTranslation("shell");
  const label = labelProp ?? t("dock");
  const reduced = useReducedMotion();
  const instant = { duration: 0 };
  const [hovered, setHovered] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [tipX, setTipX] = useState(0);
  const entries = items.filter(isEntry);
  const tip = entries.find((item) => item.id === hovered);
  // The label rides over the centre of the hovered slot, measured from the real layout.
  useLayoutEffect(() => {
    const cell = hovered ? root.current?.querySelector<HTMLElement>(`[data-dock-id="${hovered}"]`) : null;
    if (cell) setTipX(cell.offsetLeft + cell.offsetWidth / 2);
  }, [hovered, items.length]);
  const focusItem = (id: string) => root.current?.querySelector<HTMLElement>(`[data-dock-id="${id}"] > .k-dock-item`)?.focus();
  const run = (item: DockEntry) => {
    if (item.disabled) return;
    if (item.tray) setOpen((current) => current === item.id ? null : item.id);
    else { setOpen(null); onSelect(item.id); }
  };
  const keys = (item: DockEntry) => (e: KeyboardEvent) => {
    const enabled = entries.filter((entry) => !entry.disabled);
    const at = enabled.findIndex((entry) => entry.id === item.id);
    const move = (to: number) => { e.preventDefault(); const next = enabled[(to + enabled.length) % enabled.length]; if (next) focusItem(next.id); };
    switch (e.key) {
      case "ArrowRight": move(at + 1); break;
      case "ArrowLeft": move(at - 1); break;
      case "Home": move(0); break;
      case "End": move(enabled.length - 1); break;
      case "ArrowUp": if (item.tray) { e.preventDefault(); setOpen(item.id); } break;
      case "Escape": if (open) { e.preventDefault(); e.stopPropagation(); setOpen(null); } break;
    }
  };
  return <LayoutGroup id={`dock-${label}`}>
    <div ref={root} className={`k-dock${tone === "dark" ? " is-dark" : ""} ${className}`} role="toolbar" aria-label={label}
      onMouseLeave={() => setHovered(null)}>
      {readout && <div className="k-dock-readout"><span className="k-label">{readout}</span></div>}
      {items.map((item, k) => item === "sep"
        ? <span key={`sep-${k}`} className="k-dock-sep" aria-hidden="true" />
        : <div key={item.id} className="k-dock-cell" data-dock-id={item.id} onMouseEnter={() => setHovered(item.id)}>
          {item.menu ? <Menu.Root modal={false} disabled={item.disabled} onOpenChange={(next) => setOpen(next ? item.id : null)}>
            <Menu.Trigger className={`k-dock-item${item.tone ? ` is-${item.tone}` : ""}`} aria-label={item.label} disabled={item.disabled}
              onFocus={() => setHovered(item.id)} onBlur={() => setHovered((h) => h === item.id ? null : h)} onKeyDown={keys(item)}>
              <span className="k-dock-icon">{item.icon}</span>
            </Menu.Trigger>
            <MenuPopup side="top" align="center" sideOffset={10} width={item.menuWidth} label={item.label}>{item.menu}</MenuPopup>
          </Menu.Root>
          : <motion.button type="button" className={`k-dock-item${item.tone ? ` is-${item.tone}` : ""}`} aria-pressed={item.tray ? undefined : value === item.id}
            aria-label={item.shortcut ? t("dockItem", { label: item.label, shortcut: item.shortcut }) : item.label} disabled={item.disabled}
            aria-haspopup={item.tray ? "true" : undefined} aria-expanded={item.tray ? open === item.id : undefined}
            onFocus={() => setHovered(item.id)} onBlur={() => setHovered((h) => h === item.id ? null : h)}
            onClick={() => run(item)} onKeyDown={keys(item)}
            whileTap={item.disabled ? undefined : { scale: 0.9 }} transition={reduced ? instant : arcSpring.snappy}>
            {value === item.id && <motion.span layoutId="k-dock-sel" className="k-dock-sel" transition={reduced ? instant : arcSpring.morph} />}
            <span className="k-dock-icon">{item.icon}</span>
            {!!item.badge && <span className="k-dock-badge">{item.badge}</span>}
          </motion.button>}
          <AnimatePresence>
            {item.tray && open === item.id && <motion.div className="k-dock-tray" role="group" aria-label={item.label}
              initial={{ opacity: 0, y: reduced ? 0 : 6, scale: reduced ? 1 : 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={reduced ? { duration: 0.12 } : arcSpring.smooth}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); focusItem(item.id); } }}>
              {item.tray.map((member, i) => <motion.button type="button" key={member.id} className="k-dock-item" aria-label={member.label}
                aria-pressed={item.trayValue === member.id} onClick={() => { setOpen(null); onSelect(item.id, member.id); }}
                initial={{ opacity: 0, y: reduced ? 0 : 4 }} animate={{ opacity: 1, y: 0 }}
                transition={reduced ? { duration: 0.12 } : { ...arcSpring.snappy, delay: i * 0.035 }}>
                <span className="k-dock-icon">{member.icon}</span></motion.button>)}
            </motion.div>}
          </AnimatePresence>
        </div>)}
      <AnimatePresence>
        {tip && !((tip.tray || tip.menu) && open === tip.id) && <motion.div layoutId="k-dock-tip" className="k-dock-tip" aria-hidden="true"
          style={{ left: tipX, x: "-50%" }} initial={{ opacity: 0, y: reduced ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0.1 } : arcSpring.snappy}>
          {tip.label}{tip.shortcut && <kbd>{tip.shortcut}</kbd>}{tip.note && <span className="k-dock-tip-note">{tip.note}</span>}
        </motion.div>}
      </AnimatePresence>
    </div>
  </LayoutGroup>;
}
