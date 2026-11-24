import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { SearchInput } from "../bindings/SearchInput";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";

/**
 * 筛出没有完成自动标签的图（#475）：回到全部图库，查找框里只留这一个条件块，画师可以去掉。
 * 返回右下角图标“查看这些图”用的函数；设置里的“查看”经 `request` 递增触发。
 */
export function useShowUnfinishedTagging({
  request,
  onOpenBrowse,
  changeSearch,
  setWorkspaceScope,
}: {
  request: number;
  onOpenBrowse: () => void;
  changeSearch: Dispatch<SetStateAction<SearchInput>>;
  setWorkspaceScope: (scope: WorkspaceScope) => void;
}) {
  const show = () => {
    onOpenBrowse();
    setWorkspaceScope({ kind: "all" });
    changeSearch((prev) => ({ ...prev, conditions: [{ any: [{ kind: "taggingUnfinished" }], negate: false }] }));
  };
  const handled = useRef(request);
  // biome-ignore lint/correctness/useExhaustiveDependencies(show): 只在 request 递增时执行；show 每次渲染都是新函数
  useEffect(() => {
    if (handled.current === request) return;
    handled.current = request;
    show();
  }, [request]);
  return show;
}
