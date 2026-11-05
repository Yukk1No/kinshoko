import { useCallback, useEffect, useRef, useState } from "react";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import { libraryRecovery } from "../ipc";
import { useSaveDestination } from "./SaveDestination";

/** 某个资料库这次打开时的对账结果；重新导入回到这个资料库。 */
export type LibraryRecovery = { libraryId: string; libraryName: string; report: RecoveryReport };

/**
 * 上次导入中断属于被中断的那个资料库，与画师在看哪里、要存到哪里无关（ADR-0008）：登记的资料库逐个读一次，
 * 读不到的（盘没插、正忙）不挡别的库，登记变化时再试。逐个读是因为读的时候后端可能要打开并对账那个库。
 * 取消登记会放掉后端的句柄，再登记时是一次新的打开：旧结果和还没回来的旧请求都不再算数。
 */
export function useImportRecovery() {
  const { providers } = useSaveDestination();
  const [pending, setPending] = useState<LibraryRecovery[]>([]);
  /** 读过或正在读的资料库；值是那一次读取的凭据，取消登记后再登记就对不上了。 */
  const read = useRef(new Map<string, object>());
  useEffect(() => {
    let alive = true;
    const registered = new Set(providers.map(provider => provider.registration.library.id));
    for (const id of read.current.keys()) if (!registered.has(id)) read.current.delete(id);
    setPending(previous => previous.every(entry => registered.has(entry.libraryId)) ? previous : previous.filter(entry => registered.has(entry.libraryId)));
    void (async () => {
      for (const { registration: { library, unavailable } } of providers) {
        if (!alive) return;
        if (unavailable || read.current.has(library.id)) continue;
        const attempt = {};
        read.current.set(library.id, attempt);
        try {
          const report = await libraryRecovery(library.id);
          if (read.current.get(library.id) === attempt && (report.interrupted.length > 0 || report.orphans.length > 0)) {
            setPending(previous => [...previous, { libraryId: library.id, libraryName: library.name, report }]);
          }
        } catch {
          if (read.current.get(library.id) === attempt) read.current.delete(library.id);
        }
      }
    })();
    return () => { alive = false; };
  }, [providers]);
  const dismiss = useCallback((recovery: LibraryRecovery) => {
    setPending(previous => previous.filter(entry => entry !== recovery));
  }, []);
  // 一次提示一个资料库，关掉后轮到下一个。
  return { recovery: pending[0] ?? null, dismiss };
}
