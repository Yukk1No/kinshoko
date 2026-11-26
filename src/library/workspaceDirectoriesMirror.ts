import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import type { SaveMemory } from "../bindings/SaveMemory";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import { isCursorExpired, onWorkspaceChanged, registeredLibraries, saveMemory, workspaceDirectories } from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";

/**
 * 工作区目录的后端镜像（#760）：保存入口与侧栏共用同一份读取；事件失效、过期重试、
 * 代次防乱序与退订都在镜像原语里。`safe` 是浏览透镜的一部分，两个视角不共用快照。
 */
export type WorkspaceDirectoriesKey = "workspace-directories:safe" | "workspace-directories:full";

export const workspaceDirectoriesKey = (safe: boolean): WorkspaceDirectoriesKey =>
  safe ? "workspace-directories:safe" : "workspace-directories:full";

const workspaceDirectoriesMirror = createBackendMirror<WorkspaceDirectoriesKey, WorkspaceDirectories>({
  read: (key) => workspaceDirectories(key === "workspace-directories:safe"),
  stale: (error) => isCursorExpired(error),
  listen: (invalidate) => onWorkspaceChanged(() => invalidate()),
});

export function useWorkspaceDirectories(safe: boolean, enabled = true) {
  return useBackendMirror(workspaceDirectoriesMirror, workspaceDirectoriesKey(safe), enabled);
}

export function invalidateWorkspaceDirectories(safe?: boolean) {
  workspaceDirectoriesMirror.invalidate(safe === undefined ? undefined : workspaceDirectoriesKey(safe));
}

const REGISTERED_LIBRARIES_KEY = "registered-libraries";

/** 资料库登记只读镜像；工作区事件本身带着完整登记列表，直接接受，不为同一件事再读一遍。 */
const registeredLibrariesMirror = createBackendMirror<typeof REGISTERED_LIBRARIES_KEY, LibraryRegistration[]>({
  read: () => registeredLibraries(),
  listen: (_invalidate, accept) => onWorkspaceChanged((status) => accept(REGISTERED_LIBRARIES_KEY, status.libraries)),
});

export function useRegisteredLibraries(enabled = true) {
  return useBackendMirror(registeredLibrariesMirror, REGISTERED_LIBRARIES_KEY, enabled);
}

export function invalidateRegisteredLibraries() {
  registeredLibrariesMirror.invalidate(REGISTERED_LIBRARIES_KEY);
}

const SAVE_MEMORY_KEY = "save-memory";

/** 保存入口各自“上次亲手选的”记忆；真相仍在后端 device.json（ADR-0016）。 */
const saveMemoryMirror = createBackendMirror<typeof SAVE_MEMORY_KEY, SaveMemory>({
  read: () => saveMemory(),
  // 取消登记会清掉记住的目标；登记变化时重读。
  listen: (invalidate) => onWorkspaceChanged(() => invalidate(SAVE_MEMORY_KEY)),
});

export function useSaveMemory(enabled = true) {
  return useBackendMirror(saveMemoryMirror, SAVE_MEMORY_KEY, enabled);
}

/** 记忆写入已成功后的最新值；还没读到完整记忆时不能拿局部改动冒充，改为重读。 */
export function acceptSaveMemoryUpdate(update: (current: SaveMemory) => SaveMemory) {
  const current = saveMemoryMirror.snapshot(SAVE_MEMORY_KEY).value;
  if (current === null) saveMemoryMirror.invalidate(SAVE_MEMORY_KEY);
  else saveMemoryMirror.accept(SAVE_MEMORY_KEY, update(current));
}
