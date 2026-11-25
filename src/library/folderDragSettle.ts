import { reducedNow } from "../ui/reducedMotion";
import { LAND, LAND_MS } from "./folderDragMotion";
import { readRows, type Place } from "./folderDragRows";

/**
 * 跑一次移动，再让每一行从移动前在屏幕上的位置（from，按文件夹 id）弹到新位置；移动后焦点落在挪过去的文件夹上。
 * cleanup 在目录重画之后、量新位置之前调用：拖动留下的 transform 在这时拿掉。
 */
export async function moveAndSettle(
  nav: Element,
  folderId: string,
  run: () => Promise<unknown>,
  from: Map<string, Place>,
  cleanup: () => void = () => {},
) {
  const changed = new Promise<void>((done) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      done();
    });
    observer.observe(nav, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      done();
    }, 800);
  });
  try {
    await run();
  } catch {
    cleanup();
    return;
  }
  await changed;
  // 放进刚展开的文件夹时，子文件夹那一块要再画一帧才出来。
  await new Promise((done) => requestAnimationFrame(done));
  cleanup();
  const rows = readRows(nav);
  const landed = rows.find((row) => row.id === folderId);
  landed?.button.focus({ preventScroll: true });
  landed?.button.scrollIntoView({ block: "nearest" });
  if (reducedNow() || !landed) return;
  const at = rows.indexOf(landed);
  for (const [index, row] of rows.entries()) {
    const was = from.get(row.id);
    if (!was) continue;
    const dx = was.left - row.left;
    const dy = was.top - row.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && was.scale === 1) continue;
    // 离落点越远的行越晚出发，像水波一样散出去。
    const mine = row.id === folderId;
    row.el.style.zIndex = mine ? "2" : "";
    row.el
      .animate([{ transform: `translate(${dx}px, ${dy}px) scale(${was.scale})` }, { transform: "none" }], {
        duration: LAND_MS,
        easing: LAND,
        delay: mine ? 0 : Math.min(Math.abs(index - at), 8) * 16,
        fill: "backwards",
      })
      .finished.then(
        () => {
          row.el.style.zIndex = "";
        },
        () => {},
      );
  }
}
