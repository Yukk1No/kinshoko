// The opt-in local usage log from the acceptance contract (反馈渠道): off by default, written
// only to this browser, exported by the artist on purpose. Pictures are named by hash prefix;
// no file names, no image data, nothing is sent anywhere.

export type LogEntry = { t: number; type: string; [field: string]: unknown };

const KEY = 'kinshoko.reference-browser.v1.log';
let enabled = false;

export function setLogging(on: boolean) { enabled = on; }

export function log(type: string, fields: Record<string, unknown> = {}) {
  if (!enabled) return;
  try {
    const list: LogEntry[] = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    list.push({ t: Date.now(), type, ...fields });
    localStorage.setItem(KEY, JSON.stringify(list.slice(-5000)));
  } catch { /* storage unavailable: drop the entry */ }
}

export function readLog(): LogEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function clearLog() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

export function exportLog() {
  const payload = {
    prototype: 'reference-browser', exportedAt: new Date().toISOString(),
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio }, userAgent: navigator.userAgent,
    entries: readLog(),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `kinshoko-browse-log-${Date.now()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const hashOf = (image: { sha256: string | null; id: string }) => image.sha256 ? image.sha256.slice(0, 12) : image.id.startsWith('fixture') ? image.id : 'capture';
