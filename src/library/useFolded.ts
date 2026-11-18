import { useCallback, useState } from "react";

const key = (libraryId: string) => `kinshoko.sidebar.folded.${libraryId}`;

function load(libraryId: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(libraryId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** 左栏里折起了哪些文件夹（#608）：每个图库各记一份，记在本机，重开程序还在。 */
export function useFolded(libraryId: string): [ReadonlySet<string>, (id: string) => void] {
  const [folded, setFolded] = useState(() => load(libraryId));
  const toggle = useCallback(
    (id: string) =>
      setFolded((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        try {
          localStorage.setItem(key(libraryId), JSON.stringify([...next]));
        } catch {
          // 忽略失败：存不下也照样折起，只是重开后不记得。
        }
        return next;
      }),
    [libraryId],
  );
  return [folded, toggle];
}
