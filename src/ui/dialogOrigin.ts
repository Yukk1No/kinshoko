/**
 * 对话框从打开它的按钮处放大出现，关上时缩回那里（#448）。
 *
 * 各处对话框用的都是 `.k-dialog` 外壳，打开方式各不相同（按钮、菜单项、选完文件后才弹出）。这里在页面上统一记下“刚点的是哪个控件”，
 * 对话框插入页面时把 `transform-origin` 设到那个控件的中心，并标上 `data-k-from="trigger"`；起止的缩放与时长在 ui-dock.css。
 *
 * 认哪个控件：
 * - 点下后一秒内打开的对话框，从点的控件长出来（控件已经不在时，用点下时它的位置）。
 * - 点菜单项后菜单关上、焦点回到菜单按钮，之后打开的对话框从菜单按钮长出来（导入：选完文件才弹出）。
 * - 隔了更久打开的，只在焦点仍停在那个控件上时才认。按了别的键、点了别处，就不再认。
 * - 认不出来源（快捷键、拖进窗口、自动弹出）时保持原样，从窗口中间出现。
 * 关上时按控件此刻的位置重新算一次；控件不在了，就缩回打开时的位置。
 * 系统减弱动效时 tokens.css 把时长归零，直接到终态。
 */

const RECENT_MS = 1000;
const CONTROL =
  'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="option"]';
const POPUP = ".k-dialog";
const MENU = '[role="menu"]';

type Point = { x: number; y: number };
type Source = { el: Element; point: Point; at: number; inMenu: boolean };

const centre = (el: Element): Point | null => {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** 弹窗未缩放时左上角的位置。弹窗按自身中心缩放，外框中心不随缩放变；宽高取排版尺寸，不受缩放影响。 */
function popupCorner(popup: HTMLElement): Point {
  const r = popup.getBoundingClientRect();
  return {
    x: r.left + r.width / 2 - popup.offsetWidth / 2,
    y: r.top + r.height / 2 - popup.offsetHeight / 2,
  };
}

function aim(popup: HTMLElement, at: Point) {
  // 先回到中心原点再量，量完再设到控件处。
  popup.style.transformOrigin = "";
  const corner = popupCorner(popup);
  popup.style.transformOrigin = `${at.x - corner.x}px ${at.y - corner.y}px`;
}

export function installDialogOrigin(win: Window = window): () => void {
  const doc = win.document;
  let pending: Source | null = null;
  let lastFocus: Element | null = null;
  const sources = new WeakMap<HTMLElement, { el: Element; point: Point }>();

  const onPointerDown = (e: Event) => {
    const target = e.target as Element | null;
    // 点在对话框外又不是控件：不再认之前的控件。
    if (!target?.closest?.(CONTROL)) pending = null;
  };
  const onClick = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.(CONTROL);
    if (!el) return;
    const point = centre(el);
    if (!point) return;
    pending = { el, point, at: performance.now(), inMenu: el.closest(MENU) !== null };
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // 回车、空格会接着触发 click，由 click 记下；别的键（快捷键）打开的对话框不认之前点的控件。
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Tab" && !e.key.startsWith("Shift")) pending = null;
  };
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target as Element | null;
    if (!target || target === doc.body || target.closest(`${POPUP}, ${MENU}`)) return;
    lastFocus = target;
    // 菜单关上后焦点回到菜单按钮：之后的对话框从这个按钮长出来。
    if (pending?.inMenu) {
      const point = centre(target);
      if (point) pending = { el: target, point, at: pending.at, inMenu: false };
    }
  };

  const sourceFor = (): { el: Element; point: Point } | null => {
    const p = pending;
    if (!p) return null;
    const recent = performance.now() - p.at < RECENT_MS;
    const held = p.el.isConnected && lastFocus !== null && (lastFocus === p.el || p.el.contains(lastFocus));
    if (!recent && !held) return null;
    return { el: p.el, point: centre(p.el) ?? p.point };
  };

  const opened = (popup: HTMLElement) => {
    if (sources.has(popup)) return;
    const source = sourceFor();
    if (!source) return;
    pending = null;
    sources.set(popup, source);
    popup.dataset.kFrom = "trigger";
    aim(popup, source.point);
  };
  const closing = (popup: HTMLElement) => {
    const source = sources.get(popup);
    if (!source) return;
    // 弹窗打开后可能变高变宽（DialogHeight），控件也可能挪了位置：按此刻重新算。
    aim(popup, centre(source.el) ?? source.point);
  };

  const scan = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(POPUP)) opened(node);
    for (const popup of node.querySelectorAll<HTMLElement>(POPUP)) opened(popup);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(scan);
      else if (record.target instanceof HTMLElement && record.target.matches(POPUP)) {
        if (record.target.hasAttribute("data-ending-style")) closing(record.target);
      }
    }
  });
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-ending-style"],
  });

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
  };
}
