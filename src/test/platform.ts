// 前端只在 WebView2 里运行，单元测试却跑在 jsdom 里。这里补上 jsdom 缺的浏览器接口，产品代码照真实环境写，
// 不为测试留“接口不存在”的分支（#537）。默认行为等于“什么都不发生”，测试用下面导出的开关驱动它们。
//
// 用直接赋值安装，不用 vi.stubGlobal：测试里的 vi.stubGlobal 仍能盖过它，vi.unstubAllGlobals() 之后回到这一份。

type Entry = Pick<ResizeObserverEntry, "target" | "contentRect">;

const observed = new Map<Element, Set<FakeResizeObserver>>();

// jsdom 没有 ResizeObserver。观察者不主动回调，测试改完尺寸后调用 resize()。
class FakeResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target);
    let observers = observed.get(target);
    if (!observers) observed.set(target, (observers = new Set()));
    observers.add(this);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
    observed.get(target)?.delete(this);
  }
  disconnect() {
    for (const target of [...this.targets]) this.unobserve(target);
  }
  notify(entry: Entry) {
    this.callback([entry as ResizeObserverEntry], this);
  }
}

/** 触发某个元素上登记的 ResizeObserver 回调；测试改完尺寸后调用。 */
export function resize(target: Element): void {
  const entry: Entry = { target, contentRect: target.getBoundingClientRect() };
  for (const observer of [...(observed.get(target) ?? [])]) observer.notify(entry);
}

const media = new Map<string, boolean>();
const mediaLists = new Set<FakeMediaQueryList>();

// jsdom 没有 matchMedia。默认所有媒体查询都不命中，测试用 setMedia() 改。
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  onchange: MediaQueryList["onchange"] = null;
  constructor(readonly media: string) {
    super();
  }
  get matches() {
    return media.get(this.media) ?? false;
  }
  addListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) {
    if (listener) this.addEventListener("change", listener as EventListener);
  }
  removeListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) {
    if (listener) this.removeEventListener("change", listener as EventListener);
  }
}

/** 让一条媒体查询命中或不命中，并通知监听者。默认都不命中。 */
export function setMedia(query: string, matches: boolean): void {
  if ((media.get(query) ?? false) === matches) return;
  media.set(query, matches);
  for (const list of mediaLists) {
    if (list.media !== query) continue;
    const event = Object.assign(new Event("change"), { matches, media: query });
    list.onchange?.call(list, event as MediaQueryListEvent);
    list.dispatchEvent(event);
  }
}

const running = new Map<Element, FakeAnimation[]>();

// jsdom 没有 KeyframeEffect：只记下目标、关键帧与时间参数，供测试检查。
class FakeKeyframeEffect {
  constructor(
    readonly target: Element,
    private readonly keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    private readonly timing: KeyframeEffectOptions,
  ) {}
  getKeyframes() {
    return this.keyframes;
  }
  getTiming() {
    return this.timing;
  }
}

/**
 * Element.animate 返回的假动画。不自动结束：测试用 animations(el) 拿到它，自己调 finish() 或 cancel()；
 * 自动结束等于又造了一条真实应用里没有的时序。
 */
export class FakeAnimation extends EventTarget {
  readonly effect: FakeKeyframeEffect;
  startTime: number | null = null;
  playState: AnimationPlayState = "running";
  onfinish: ((this: Animation, event: AnimationPlaybackEvent) => unknown) | null = null;
  oncancel: ((this: Animation, event: AnimationPlaybackEvent) => unknown) | null = null;
  readonly finished: Promise<Animation>;
  private settle!: { resolve: (animation: Animation) => void; reject: (reason: unknown) => void };
  constructor(
    target: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ) {
    super();
    this.effect = new FakeKeyframeEffect(
      target,
      keyframes,
      typeof options === "number" ? { duration: options } : { ...options },
    );
    this.finished = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    // 和浏览器一样，取消时 finished 的拒绝不算未处理。
    this.finished.catch(() => {});
    const list = running.get(target);
    if (list) list.push(this);
    else running.set(target, [this]);
  }
  finish() {
    if (this.playState !== "running") return;
    this.end("finished");
    this.settle.resolve(this as unknown as Animation);
    this.fire("finish", this.onfinish);
  }
  cancel() {
    if (this.playState !== "running") return;
    this.end("idle");
    this.settle.reject(new DOMException("The user aborted a request.", "AbortError"));
    this.fire("cancel", this.oncancel);
  }
  private end(state: AnimationPlayState) {
    this.playState = state;
    const list = running.get(this.effect.target);
    list?.splice(list.indexOf(this), 1);
  }
  private fire(type: string, handler: FakeAnimation["onfinish"]) {
    const event = new Event(type) as AnimationPlaybackEvent;
    handler?.call(this as unknown as Animation, event);
    this.dispatchEvent(event);
  }
}

/** 这个元素上还没结束的动画；测试用它检查关键帧，或手动结束动画。 */
export function animations(target: Element): FakeAnimation[] {
  return [...(running.get(target) ?? [])];
}

/** 每个用例之后回到初始状态：没有观察者，媒体查询都不命中，没有未结束的动画。 */
export function resetPlatform(): void {
  observed.clear();
  media.clear();
  mediaLists.clear();
  running.clear();
}

globalThis.ResizeObserver = FakeResizeObserver;

window.matchMedia = (query: string) => {
  const list = new FakeMediaQueryList(query);
  mediaLists.add(list);
  return list;
};

// jsdom 没有实现 Web Animations。getAnimations 只报 animate() 起的、还没结束的动画（没有 CSS 过渡）。
(globalThis as { KeyframeEffect?: unknown }).KeyframeEffect ??= FakeKeyframeEffect;
// animate 装在 HTMLElement 与 SVGElement 上，不装在 Element.prototype 上：motion 见到 Element.prototype.animate
// 就改走 WAAPI，要用到这个假动画没有的 currentTime、pause() 等；这样它照旧走自己逐帧推进的那条路。
const animate = function (
  this: Element,
  keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
  options?: number | KeyframeAnimationOptions,
) {
  return new FakeAnimation(this, keyframes, options) as unknown as Animation;
};
HTMLElement.prototype.animate = animate;
SVGElement.prototype.animate = animate;
Element.prototype.getAnimations = function (this: Element) {
  return animations(this) as unknown as Animation[];
};
document.getAnimations = () => [...running.values()].flat() as unknown as Animation[];
// base-ui 见到 getAnimations 就改为隔一帧再等动画结束才收起弹层；关掉它，弹层照旧同步收起。
(globalThis as { BASE_UI_ANIMATIONS_DISABLED?: boolean }).BASE_UI_ANIMATIONS_DISABLED = true;

// jsdom 没有指针捕获。只记下捕获了哪些指针，不派发 got/lostpointercapture。
const captured = new WeakMap<Element, Set<number>>();
Element.prototype.setPointerCapture = function (this: Element, pointerId: number) {
  let ids = captured.get(this);
  if (!ids) captured.set(this, (ids = new Set()));
  ids.add(pointerId);
};
Element.prototype.releasePointerCapture = function (this: Element, pointerId: number) {
  captured.get(this)?.delete(pointerId);
};
Element.prototype.hasPointerCapture = function (this: Element, pointerId: number) {
  return captured.get(this)?.has(pointerId) ?? false;
};

// jsdom 不排版，也没有 scrollIntoView。
Element.prototype.scrollIntoView = () => {};

// jsdom 不解码图片，也没有 HTMLImageElement.decode：当作立即解码完成。
HTMLImageElement.prototype.decode = () => Promise.resolve();
