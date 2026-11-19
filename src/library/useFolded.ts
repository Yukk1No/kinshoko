import { useCallback, useEffect, useState } from "react";
import { useReducedMotion } from "../ui/reducedMotion";

/** 折起时子文件夹留多久放完收起动画，与图库托盘相同。 */
const FOLD_MS = 300;

const key = (libraryId: string) => `kinshoko.sidebar.folded.${libraryId}`;

function load(libraryId: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(libraryId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * 左栏里折起了哪些文件夹（#608）：每个图库各记一份，记在本机，重开程序还在。
 * 第三项是正在收起的文件夹：子文件夹先留着放完收起动画（FOLD_MS）再拿掉；减少动态效果时没有。
 */
export function useFolded(libraryId: string): [ReadonlySet<string>, (id: string) => void, ReadonlySet<string>] {
  const reduced = useReducedMotion();
  const [folded, setFolded] = useState(() => load(libraryId));
  const [closing, setClosing] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (id: string) => {
      const folding = !folded.has(id);
      setFolded((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        try {
          localStorage.setItem(key(libraryId), JSON.stringify([...next]));
        } catch {
          // 忽略失败：存不下也照样折起，只是重开后不记得。
        }
        return next;
      });
      setClosing((was) => {
        const next = new Set(was);
        if (folding && !reduced) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [libraryId, folded, reduced],
  );
  useEffect(() => {
    if (closing.size === 0) return;
    const timer = setTimeout(() => setClosing(new Set()), FOLD_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  return [folded, toggle, closing];
}
