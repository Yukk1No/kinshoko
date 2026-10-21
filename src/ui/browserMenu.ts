/** 能输入文字的 input：右键时留给系统的剪切、复制、粘贴菜单。 */
const TEXT_INPUTS = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // 被禁用的输入框编辑不了，系统菜单也就没有用处。
  if (target instanceof HTMLTextAreaElement) return !target.disabled;
  if (target instanceof HTMLInputElement) return !target.disabled && TEXT_INPUTS.has(target.getAttribute("type")?.toLowerCase() ?? "");
  return (target as HTMLElement).isContentEditable || !!target.closest('[contenteditable]:not([contenteditable="false"])');
}

/**
 * 不弹 WebView 自带的浏览器菜单（返回、刷新、另存为、打印……，#229）：自己有菜单的地方各自处理
 * `contextmenu`，其余地方右键什么都不弹；能输入文字的地方保留系统菜单。在捕获阶段拦，子元素
 * `stopPropagation()` 也绕不过去（钉图里的运行环境提示）。返回撤销函数。
 */
export function blockBrowserMenu(target: Window): () => void {
  const onMenu = (e: MouseEvent) => {
    if (!editable(e.target)) e.preventDefault();
  };
  target.addEventListener("contextmenu", onMenu, { capture: true });
  return () => target.removeEventListener("contextmenu", onMenu, { capture: true });
}
