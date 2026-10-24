// 钉图层里的快捷键归哪个钉图（#193）：一台显示器上的钉图都在同一个层窗口里，H/V/R/Esc 作用在
// 光标下的钉图上；光标不在钉图上时作用在最近按过的那个；层里只有一个钉图时就是它。

export type PinKeyHandler = (e: KeyboardEvent) => void;

export class PinKeys {
  private handlers = new Map<string, PinKeyHandler>();
  private hovered: string | null = null;
  private active: string | null = null;

  /** 钉图挂上自己的按键处理；返回撤销函数。 */
  register(pin: string, handler: PinKeyHandler): () => void {
    this.handlers.set(pin, handler);
    return () => {
      if (this.handlers.get(pin) === handler) this.handlers.delete(pin);
      if (this.hovered === pin) this.hovered = null;
      if (this.active === pin) this.active = null;
    };
  }

  enter(pin: string) {
    this.hovered = pin;
  }

  leave(pin: string) {
    if (this.hovered === pin) this.hovered = null;
  }

  press(pin: string) {
    this.active = pin;
  }

  /** 此刻收按键的钉图。 */
  target(): string | null {
    for (const pin of [this.hovered, this.active]) {
      if (pin && this.handlers.has(pin)) return pin;
    }
    return this.handlers.size === 1 ? [...this.handlers.keys()][0] : null;
  }

  /** 层窗口的 keydown：不让 WebView 自己缩放页面，其余交给收按键的钉图。 */
  dispatch(e: KeyboardEvent) {
    if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) {
      e.preventDefault();
      return;
    }
    const pin = this.target();
    if (pin) this.handlers.get(pin)?.(e);
  }

  /** 挂到窗口上；返回撤销函数。 */
  attach(target: Window): () => void {
    const onKey = (e: KeyboardEvent) => this.dispatch(e);
    target.addEventListener("keydown", onKey);
    return () => target.removeEventListener("keydown", onKey);
  }
}
