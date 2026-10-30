import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import { isLensChanged, workspaceResolve } from "../ipc";
import { useUiLang } from "../i18n";

/** 查找条件与它解析成的条件树。 */
export function useSearchTree({ libraryId, safe, vocabularyKey, onError, setReloadKey }: {
  libraryId: string;
  safe: boolean;
  vocabularyKey: number;
  onError: (message: string) => void;
  setReloadKey: Dispatch<SetStateAction<number>>;
}) {
  const lang = useUiLang();
  const [search, setSearch] = useState<SearchInput>({ conditions: [], exact: false });
  const [tree, setTree] = useState<ConditionTree>({ conditions: [] });
  /** 条件树是在哪个视角下解析的：与当前不同时，搜索框不显示它展开的标签名（#76）。 */
  const [treeSafe, setTreeSafe] = useState(safe);

  // 条件变化时由 Search 解析成条件树，图片墙按它浏览。
  const searching = search.conditions.length > 0;
  useEffect(() => {
    if (!searching) {
      setTree((prev) => (prev.conditions.length ? { conditions: [] } : prev));
      return;
    }
    let alive = true;
    workspaceResolve(search, lang, safe).then(
      (next) => {
        if (!alive) return;
        setTree(next);
        setTreeSafe(safe);
        // 同一棵条件树的结果也可能变了（图片的标签变了），保持位置重新浏览。
        if (vocabularyKey) setReloadKey((k) => k + 1);
      },
      // 安全模式刚切换、资料库还没跟上：等它确认（safeModeChanged）后按新视角重新解析。
      (e) => alive && !isLensChanged(e) && onError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, search, searching, vocabularyKey, safe, onError, lang]);

  return { search, setSearch, tree, treeSafe, searching };
}
