import { useCallback, useSyncExternalStore } from "react";
import type { BackendMirror, MirrorSnapshot } from "./backendMirror";

const EMPTY: MirrorSnapshot<never> = Object.freeze({
  value: null,
  error: null,
  loading: false,
  refreshing: false,
});

/** React 接到后端镜像上；`enabled` 为 false 时不订阅、读取为空。 */
export function useBackendMirror<Key extends string, Value>(
  mirror: BackendMirror<Key, Value>,
  key: Key,
  enabled = true,
): MirrorSnapshot<Value> {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? mirror.subscribe(key, listener) : () => {}),
    [mirror, key, enabled],
  );
  const snapshot = useCallback(
    () => (enabled ? mirror.snapshot(key) : (EMPTY as MirrorSnapshot<Value>)),
    [mirror, key, enabled],
  );
  return useSyncExternalStore(subscribe, snapshot);
}
