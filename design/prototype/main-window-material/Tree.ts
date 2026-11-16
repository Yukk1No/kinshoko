// 第八轮（C4f、C4g）：子文件夹的层级。叠在正式程序的左栏上，只读写 DOM，不改 src/。
//   1. 有子文件夹的文件夹可以折起。点它的图标折起或展开；指针停在图标上时，图标先变成点下去之后的样子
//      （打开的文件夹合上，合上的文件夹打开），不另加箭头。键盘：← 折起，→ 展开。
//   2. 图标画成两层：后面的夹子、前面的一页。展开时前面那一页翻下来，折起时合上、颜色深一档（看得出里面装着东西）；两种样子之间是同一条路径在变。
//   3. 折起时子文件夹各行合上，展开时依次落下，与图库的展开同一种动作。
// 正式程序没有“折起文件夹”，折起了哪些只记在原型的内存里。系统设了“减少动态效果”时直接折起、展开，图标不变形。
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const folded = new Set<string>();
/** Folders.ts 写在根上的弹簧曲线（Web Animations 不认 var()）。 */
const settle = () => getComputedStyle(document.documentElement).getPropertyValue("--proto-settle").trim() || "ease-out";

const SVG = "http://www.w3.org/2000/svg";
const BACK = "M2 18V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H19a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z";

function icon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "proto-fold-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const part of ["back", "flap"]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("class", part);
    if (part === "back") path.setAttribute("d", BACK);
    svg.append(path);
  }
  return svg;
}

const rowOf = (li: HTMLElement) => li.querySelector<HTMLButtonElement>(":scope > .k-fluid-row > button[data-folder-id]");
const branchOf = (li: HTMLElement) => li.querySelector<HTMLElement>(":scope > .sidebar-tree");

/** 每次左栏重画后：给有子文件夹的行换上两层的图标，把折起的状态放回去。 */
function dress() {
  for (const li of document.querySelectorAll<HTMLElement>(".sidebar-slot .sidebar-tree > li")) {
    const row = rowOf(li), branch = branchOf(li);
    if (!row) continue;
    const slot = row.querySelector<HTMLElement>(".k-row-icon");
    if (!branch || !slot) { delete li.dataset.parent; continue; }
    li.dataset.parent = "";
    if (!slot.querySelector(".proto-fold-icon")) slot.append(icon());
    const id = row.dataset.folderId as string;
    const fold = folded.has(id);
    if (fold !== "folded" in li.dataset) { if (fold) li.dataset.folded = ""; else delete li.dataset.folded; }
    li.setAttribute("aria-expanded", String(!fold));
  }
}

function toggle(li: HTMLElement) {
  const row = rowOf(li), branch = branchOf(li);
  if (!row || !branch) return;
  const id = row.dataset.folderId as string;
  if (folded.has(id)) {
    folded.delete(id);
    delete li.dataset.folded;
    li.setAttribute("aria-expanded", "true");
    if (reduced()) return;
    const height = branch.offsetHeight;
    branch.style.overflow = "clip";
    branch.animate([{ height: "0px" }, { height: `${height}px` }], { duration: 300, easing: settle() }).finished.then(() => { branch.style.overflow = ""; }, () => {});
    [...branch.querySelectorAll<HTMLElement>(".k-fluid-row")].filter((el) => el.checkVisibility()).forEach((el, index) => {
      el.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: settle(), delay: Math.min(index, 14) * 18, fill: "backwards" });
    });
    return;
  }
  folded.add(id);
  li.setAttribute("aria-expanded", "false");
  const done = () => { branch.style.overflow = ""; li.dataset.folded = ""; };
  if (reduced()) { done(); return; }
  branch.style.overflow = "clip";
  branch.animate([{ height: `${branch.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 200, easing: "cubic-bezier(0.4, 0, 0.6, 1)" }).finished.then(done, done);
}

export function mountTree() {
  dress();
  new MutationObserver(dress).observe(document.body, { subtree: true, childList: true });
  // 点图标折起或展开，不选中这一行。
  window.addEventListener("click", (event) => {
    const slot = (event.target as Element | null)?.closest?.<HTMLElement>(".sidebar-slot li[data-parent] > .k-fluid-row .k-row-icon");
    if (!slot || "dragging" in document.documentElement.dataset) return;
    event.stopPropagation();
    event.preventDefault();
    toggle(slot.closest("li") as HTMLElement);
  }, true);
  // 拖动是按下后移动才开始；按在图标上不移动，就只是折起。
  window.addEventListener("keydown", (event) => {
    if (event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const li = (document.activeElement as Element | null)?.closest?.<HTMLElement>(".sidebar-slot li[data-parent]");
    if (!li || rowOf(li) !== document.activeElement) return;
    if ((event.key === "ArrowLeft") !== ("folded" in li.dataset)) { event.preventDefault(); toggle(li); }
  }, true);
}
