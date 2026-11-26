/**
 * 后端状态的单一镜像（#741）：按查询键缓存同一份后端状态，订阅者共用读取、失效重读、代次防乱序、
 * 过期重试与事件退订。这里只管镜像机制，不认识任何领域状态；写入方在写成功后用 `accept` 交回新的真相，
 * 让还在路上的旧读取不能把它盖掉。
 */

export type MirrorSnapshot<Value> = {
  /** 已接受的镜像；还没读到时为 null。 */
  readonly value: Value | null;
  /** 最近一次读取最终失败的原因；有旧镜像时旧镜像仍留在 `value`。 */
  readonly error: unknown;
  /** 还没有镜像、正在读第一份。 */
  readonly loading: boolean;
  /** 任意一代读取还在路上（含第一份与后台重读）。 */
  readonly refreshing: boolean;
};

export type Unlisten = () => void;

export type BackendMirror<Key extends string, Value> = {
  /** 订阅一个查询键；第一个订阅者触发读取，最后一个离开时这一代的交付资格作废。 */
  subscribe: (key: Key, listener: () => void) => Unlisten;
  snapshot: (key: Key) => MirrorSnapshot<Value>;
  /** 重新读取一个键；不给键时重读全部仍在被订阅的键。 */
  invalidate: (key?: Key) => void;
  /** 写入已成功后的最新真相：作废在途旧读取，直接成为镜像。 */
  accept: (key: Key, value: Value) => void;
};

export type BackendMirrorOptions<Key extends string, Value> = {
  read: (key: Key) => Promise<Value>;
  /**
   * 有订阅者时挂后端事件；返回退订函数（可以是 Promise，与 Tauri 的 listen 相同）。
   * 事件处理里调 `invalidate`；不给键表示全部键失效。事件本身带着完整后端真相时，
   * 也可以用 `accept` 同步交付，让还在路上的旧读取不能盖掉它。
   */
  listen?: (invalidate: (key?: Key) => void, accept: (key: Key, value: Value) => void) => Promise<Unlisten> | Unlisten;
  /** 这种失败表示读取途中后端状态已变，按统一策略重试。 */
  stale?: (error: unknown) => boolean;
  /** 测试用的计时接缝；产品代码不传，统一是 150ms。 */
  wait?: (ms: number) => Promise<void>;
};

type Entry<Value> = {
  generation: number;
  listeners: Set<() => void>;
  reads: number;
  snapshot: MirrorSnapshot<Value>;
};

type ReadResult<Value> = { kind: "value"; value: Value } | { kind: "error"; error: unknown } | { kind: "cancelled" };

const EMPTY: MirrorSnapshot<never> = Object.freeze({
  value: null,
  error: null,
  loading: false,
  refreshing: false,
});

/** 与 SaveDestination 原来手写的一致：过期后最多重试 3 次，每次隔 150ms（共发 4 次读取）。 */
const STALE_RETRIES = 3;
const STALE_RETRY_MS = 150;
const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createBackendMirror<Key extends string, Value>(
  options: BackendMirrorOptions<Key, Value>,
): BackendMirror<Key, Value> {
  const entries = new Map<Key, Entry<Value>>();
  const wait = options.wait ?? defaultWait;
  let audience = 0;
  let eventGeneration = 0;
  let eventStop: Unlisten | null = null;

  const publish = (key: Key, entry: Entry<Value>, snapshot: MirrorSnapshot<Value>) => {
    if (entries.get(key) !== entry) return;
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener();
  };

  const current = (key: Key, entry: Entry<Value>, generation: number) =>
    entries.get(key) === entry && entry.generation === generation;

  async function readOnce(key: Key, entry: Entry<Value>, generation: number): Promise<ReadResult<Value>> {
    for (let retry = 0; ; retry++) {
      try {
        return { kind: "value", value: await options.read(key) };
      } catch (error) {
        if (!current(key, entry, generation)) return { kind: "cancelled" };
        if (!options.stale?.(error) || retry >= STALE_RETRIES) return { kind: "error", error };
        await wait(STALE_RETRY_MS);
        if (!current(key, entry, generation)) return { kind: "cancelled" };
      }
    }
  }

  function startRead(key: Key, entry: Entry<Value>) {
    if (entries.get(key) !== entry) return;
    const generation = ++entry.generation;
    entry.reads++;
    publish(key, entry, {
      ...entry.snapshot,
      loading: entry.snapshot.value === null,
      refreshing: true,
    });
    void readOnce(key, entry, generation).then((result) => {
      entry.reads--;
      if (entries.get(key) !== entry) return;
      const refreshing = entry.reads > 0;
      if (generation !== entry.generation || result.kind === "cancelled") {
        publish(key, entry, {
          ...entry.snapshot,
          loading: entry.snapshot.value === null && refreshing,
          refreshing,
        });
        return;
      }
      if (result.kind === "error") {
        publish(key, entry, {
          ...entry.snapshot,
          error: result.error,
          loading: false,
          refreshing,
        });
        return;
      }
      publish(key, entry, {
        value: result.value,
        error: null,
        loading: false,
        refreshing,
      });
    });
  }

  function invalidate(key?: Key) {
    if (key !== undefined) {
      const entry = entries.get(key);
      if (entry) startRead(key, entry);
      return;
    }
    for (const [name, entry] of entries) startRead(name, entry);
  }

  function acceptValue(key: Key, value: Value) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.generation++;
    publish(key, entry, {
      value,
      error: null,
      loading: false,
      refreshing: entry.reads > 0,
    });
  }

  function attachEvents() {
    if (audience !== 1 || !options.listen) return;
    const generation = ++eventGeneration;
    let started: Promise<Unlisten> | Unlisten;
    try {
      started = options.listen(invalidate, acceptValue);
    } catch {
      return;
    }
    void Promise.resolve(started).then(
      (stop) => {
        if (generation !== eventGeneration || audience === 0) stop();
        else eventStop = stop;
      },
      () => {},
    );
  }

  function detachEvents() {
    if (audience !== 0) return;
    eventGeneration++;
    const stop = eventStop;
    eventStop = null;
    stop?.();
  }

  return {
    subscribe(key, listener) {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          generation: 0,
          listeners: new Set(),
          reads: 0,
          snapshot: EMPTY as MirrorSnapshot<Value>,
        };
        entries.set(key, entry);
      }
      entry.listeners.add(listener);
      audience++;
      attachEvents();
      if (entry.listeners.size === 1) startRead(key, entry);
      return () => {
        if (!entry.listeners.delete(listener)) return;
        audience--;
        if (entry.listeners.size === 0) {
          // 取消令牌：这之后回来的读取、等待中的重试都不再交付；下次订阅重新读。
          entry.generation++;
          entries.delete(key);
        }
        detachEvents();
      };
    },
    snapshot(key) {
      return entries.get(key)?.snapshot ?? (EMPTY as MirrorSnapshot<Value>);
    },
    invalidate,
    accept: acceptValue,
  };
}
