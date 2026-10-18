import { useEffect, useState } from "react";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { onTaggingStatus, onWritableLibrary, taggingStatus } from "./ipc";

/**
 * 自动标签的状态与它所属的资料库。打标跟着后端唯一的可写库走（ADR-0008）：整理另一个图库时它切过去，
 * 这里随之换库并重读状态；只接受这个库的状态，旧库的迟到状态不串台。
 * 跟过去的图库从 `registered` 移除时，后端卸下它的打标而不另发事件：回到打开的图库。
 * `opened` 为空（还没有图库）时没有状态。
 */
export function useTaggingStatus(opened: string | null, registered?: readonly string[]) {
  const [status, setStatus] = useState<TaggingStatus | null>(null);
  const [libraryId, setLibraryId] = useState(opened);
  useEffect(() => setLibraryId(opened), [opened]);
  useEffect(() => {
    let alive = true;
    const unlisten = onWritableLibrary((library) => alive && setLibraryId(library.id));
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);
  const gone = libraryId !== null && registered !== undefined && libraryId !== opened && !registered.includes(libraryId);
  useEffect(() => {
    if (!gone) return;
    setStatus(null);
    setLibraryId(opened);
  }, [gone, opened]);

  useEffect(() => {
    if (libraryId === null) return;
    let alive = true;
    taggingStatus(libraryId).then(
      (s) => alive && s.libraryId === libraryId && setStatus(s.status),
      () => {},
    );
    const unlisten = onTaggingStatus((s) => alive && s.libraryId === libraryId && setStatus(s.status));
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, [libraryId]);

  return { libraryId, status: libraryId === null ? null : status };
}
