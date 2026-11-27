import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import { isCursorExpired, isLensChanged, workspaceResolve } from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import { useUiLang } from "../i18n";
import type { Invalidate } from "./useBrowseResults";

const EMPTY_TREE: ConditionTree = { conditions: [] };

/** 查找条件树的后端镜像：同一个查询键共用读取、过期重试与代次防乱序；安全模式是键的一部分。 */
const searchTreeMirror = createBackendMirror<string, ConditionTree>({
  read: (key) => {
    const [input, lang, safe] = JSON.parse(key) as [SearchInput, string, boolean];
    return workspaceResolve(input, lang, safe);
  },
  stale: (error) => isCursorExpired(error) || isLensChanged(error),
});
const searchTreeKey = (search: SearchInput, lang: string, safe: boolean) => JSON.stringify([search, lang, safe]);

/** 查找条件与它解析成的条件树。 */
export function useSearchTree({
  safe,
  vocabularyKey,
  onError,
  setReloadKey,
  invalidate,
}: {
  safe: boolean;
  vocabularyKey: number;
  onError: (error: unknown) => void;
  setReloadKey: Dispatch<SetStateAction<number>>;
  invalidate: Invalidate;
}) {
  const lang = useUiLang();
  const [search, setSearch] = useState<SearchInput>({ conditions: [], exact: false });
  /** 改查找条件：图片墙随之重新查。 */
  const changeSearch = useCallback(
    (next: SetStateAction<SearchInput>) => {
      setSearch(next);
      invalidate({ kind: "conditionsChanged" });
    },
    [invalidate],
  );
  const [tree, setTree] = useState<ConditionTree>(EMPTY_TREE);
  /** 条件树是在哪个视角下解析的：与当前不同时，搜索框不显示它展开的标签名（#76）。 */
  const [treeSafe, setTreeSafe] = useState(safe);

  // 条件变化时由 Search 解析成条件树，图片墙按它浏览。新解析还没到达时保留上一棵同视角树，
  // 图片墙不切回“全部参考图”；安全模式在查询键里，旧视角的解析不能交付到新视角。
  const searching = search.conditions.length > 0;
  const key = searchTreeKey(search, lang, safe);
  const mirror = useBackendMirror(searchTreeMirror, key, searching);
  const currentKey = useRef(key);
  currentKey.current = key;
  const invalidateCurrent = useCallback(() => searchTreeMirror.invalidate(currentKey.current), []);
  const refreshed = useRef({ key, vocabularyKey });
  useLayoutEffect(() => {
    const before = refreshed.current;
    refreshed.current = { key, vocabularyKey };
    if (searching && before.key === key && before.vocabularyKey !== vocabularyKey) invalidateCurrent();
  }, [searching, key, vocabularyKey, invalidateCurrent]);

  const vocabulary = useRef(vocabularyKey);
  vocabulary.current = vocabularyKey;
  const reloaded = useRef<{ key: string; value: ConditionTree } | null>(null);
  useEffect(() => {
    if (!searching) {
      setTree((prev) => (prev.conditions.length ? EMPTY_TREE : prev));
      return;
    }
    if (mirror.value === null) return;
    setTree(mirror.value);
    setTreeSafe(safe);
    if (reloaded.current?.key === key && reloaded.current.value === mirror.value) return;
    reloaded.current = { key, value: mirror.value };
    // 同一棵条件树的结果也可能变了（图片的标签变了），保持位置重新浏览。
    if (vocabulary.current) setReloadKey((k) => k + 1);
  }, [searching, mirror.value, key, safe, setReloadKey]);

  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (!mirror.error) {
      reported.current = null;
      return;
    }
    if (reported.current === mirror.error || isLensChanged(mirror.error)) return;
    reported.current = mirror.error;
    onError(mirror.error);
  }, [mirror.error, onError]);

  return { search, changeSearch, tree, treeSafe, searching };
}
