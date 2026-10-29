import { useEffect, useState } from 'react';

const PREFIX = 'kinshoko.reference-browser.v1.';

/** localStorage-backed state. Blocked storage (private window, file:// policies) falls back to memory. */
export function usePersistent<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch { /* fall through */ }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* memory only */ }
  }, [key, value]);
  return [value, setValue] as const;
}

export function resetPersistent() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* nothing stored */ }
}
