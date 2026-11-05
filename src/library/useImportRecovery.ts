import { useCallback, useEffect, useRef, useState } from "react";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import { libraryRecovery } from "../ipc";
import { useSaveDestination } from "./SaveDestination";

/** 某个资料库这次打开时的对账结果；重新导入回到这个资料库。 */
export type LibraryRecovery = { libraryId: string; libraryName: string; report: RecoveryReport };

/**
 * 上次导入中断属于被中断的那个资料库，与画师在看哪里、要存到哪里无关（ADR-0008）：登记的资料库逐个读一次，
 * 读不到的（盘没插、正忙）不挡别的库，登记变化时再试。逐个读是因为读的时候后端可能要打开并对账那个库。
 */
export function useImportRecovery() {
  const { providers } = useSaveDestination();
  const [pending, setPending] = useState<LibraryRecovery[]>([]);
  const read = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    const registered = new Set(providers.map(provider => provider.registration.library.id));
    for (const id of read.current) if (!registered.has(id)) read.current.delete(id);
    void (async () => {
      for (const { registration: { library, unavailable } } of providers) {
        if (!alive) return;
        if (unavailable || read.current.has(library.id)) continue;
        read.current.add(library.id);
        try {
          const report = await libraryRecovery(library.id);
          if (report.interrupted.length > 0 || report.orphans.length > 0) {
            setPending(previous => [...previous, { libraryId: library.id, libraryName: library.name, report }]);
          }
        } catch {
          read.current.delete(library.id);
        }
      }
    })();
    return () => { alive = false; };
  }, [providers]);
  const dismiss = useCallback((recovery: LibraryRecovery) => {
    setPending(previous => previous.filter(entry => entry !== recovery));
  }, []);
  // 一次提示一个资料库，关掉后轮到下一个；取消登记的库不再提示。
  const recovery = pending.find(entry => providers.some(provider => provider.registration.library.id === entry.libraryId)) ?? null;
  return { recovery, dismiss };
}
