import { fireEvent, waitFor } from "@testing-library/react";

/** 打开元素上的悬停提示（`Tip`），返回提示里的文字。先聚焦；聚焦不弹的（`focus={false}`）再模拟悬停。 */
export async function tipText(el: Element): Promise<string> {
  fireEvent.focus(el);
  fireEvent.pointerEnter(el, { pointerType: "mouse" });
  fireEvent.mouseEnter(el);
  fireEvent.mouseMove(el);
  const tip = await waitFor(() => {
    const open = [...document.querySelectorAll<HTMLElement>(".k-tip")].at(-1);
    if (!open) throw new Error("提示没有打开");
    return open;
  }, { timeout: 2000 });
  return tip.textContent ?? "";
}
