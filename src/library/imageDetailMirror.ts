import type { ImageDetail } from "../bindings/ImageDetail";
import { isLensChanged, workspaceImage } from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";

/** 单图详情的后端镜像（#780）：同一资料库与图共用读取、过期重试与代次防乱序；写入成功后用 `accept` 交回最新详情。 */
export const imageDetailMirror = createBackendMirror<string, ImageDetail>({
  read: (key) => {
    const [libraryId, imageId] = JSON.parse(key) as [string, string];
    return workspaceImage(libraryId, imageId);
  },
  stale: isLensChanged,
});
export const imageDetailKey = (libraryId: string, imageId: string) => JSON.stringify([libraryId, imageId]);
