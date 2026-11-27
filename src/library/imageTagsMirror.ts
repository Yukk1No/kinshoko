import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CatalogImageTags } from "../bindings/CatalogImageTags";
import type { ImageTags } from "../bindings/ImageTags";
import type { ResolvedTagIdentity } from "../bindings/ResolvedTagIdentity";
import { catalogImageTags, isLensChanged } from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";

/** 单图标签与统一标签身份的后端镜像（#780）：同一资料库、图与语言共用读取、过期重试与代次防乱序。 */
const imageTagsMirror = createBackendMirror<string, CatalogImageTags>({
  read: (key) => {
    const [libraryId, imageId, lang] = JSON.parse(key) as [string, string, string];
    return catalogImageTags(libraryId, imageId, lang);
  },
  stale: isLensChanged,
});
const imageTagsKey = (libraryId: string, imageId: string, lang: string) => JSON.stringify([libraryId, imageId, lang]);

/**
 * 标签面板与单图标签镜像之间的接缝（#780）：面板只订阅当前这张图，镜像交付时以当时的 loadKey 记进
 * loaded，切换选中图时上一张先留着（不可操作），新的到了再换（#158）；词表代次、视角或编辑后的
 * refresh 前进时重读，语言变化换键由新键的订阅自己读。
 */
export function useImageTags(
  libraryId: string,
  single: string | null,
  identityKey: string,
  safe: boolean,
  generation: number,
  refresh: number,
  lang: string,
  onError: (error: unknown) => void,
): { tags: ImageTags | null; identities: ResolvedTagIdentity[]; stale: boolean } {
  // 读到的标签记着它属于哪一次读取：切换选中图时先留着上一张的（不可操作），新的到了再换（#158）。
  const [loaded, setLoaded] = useState<{ key: string; tags: ImageTags; identities: ResolvedTagIdentity[] } | null>(
    null,
  );
  const loadKey = JSON.stringify([identityKey, refresh, lang]);
  const currentLoadKey = useRef(loadKey);
  currentLoadKey.current = loadKey;

  const mirrorKey = single === null ? "" : imageTagsKey(libraryId, single, lang);
  const mirror = useBackendMirror(imageTagsMirror, mirrorKey, single !== null);
  const refreshed = useRef({ key: mirrorKey, generation, safe, refresh });
  useLayoutEffect(() => {
    const before = refreshed.current;
    refreshed.current = { key: mirrorKey, generation, safe, refresh };
    if (
      single !== null &&
      before.key === mirrorKey &&
      (before.generation !== generation || before.safe !== safe || before.refresh !== refresh)
    )
      imageTagsMirror.invalidate(mirrorKey);
  }, [single, mirrorKey, generation, safe, refresh]);

  useEffect(() => {
    if (!single) {
      setLoaded(null);
      return;
    }
    // 统一标签身份与有效标签出自同一次查询（#158）。
    if (mirror.value !== null)
      setLoaded({ key: currentLoadKey.current, tags: mirror.value.image, identities: mirror.value.identities });
  }, [mirror.value, single]);

  // 读取失败：清空并报告一次；同一份失败不重复上报。镜像重读成功后错误消失，标签随之恢复。
  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (mirror.error === null) {
      reported.current = null;
      return;
    }
    setLoaded(null);
    if (reported.current === mirror.error) return;
    reported.current = mirror.error;
    onError(mirror.error);
  }, [mirror.error, onError]);
  const tags = loaded?.tags ?? null;
  const identities = loaded?.identities ?? [];
  const stale = loaded !== null && loaded.key !== loadKey;
  return { tags, identities, stale };
}
