import type { BackupPreview } from "../bindings/BackupPreview";
import type { BackupStatus } from "../bindings/BackupStatus";
import { fakeBackend, type Replies } from "../test/backend";

export const at = { unixMs: 1_791_158_400_000, offsetMinutes: 480 };

export const empty: BackupStatus = {
  plan: {
    target: null,
    selection: { kind: "all" },
    lastSuccess: null,
    lastSnapshot: null,
    lastFailure: null,
    due: false,
  },
  running: null,
  lastReport: null,
};

export const withTarget: BackupStatus = {
  ...empty,
  plan: { ...empty.plan, target: "E:\\备份", lastSuccess: at, lastSnapshot: "20261005-080000-abcdef" },
};

const registrations = [
  { library: { id: "A", name: "主库", root: "D:\\主库" }, unavailable: null },
  { library: { id: "B", name: "旧库", root: "D:\\旧库" }, unavailable: null },
];

export const narrowed: BackupPreview = {
  scope: {
    libraries: [{ id: "A", name: "主库" }],
    groups: [{ id: "g1", name: "眼睛参考" }],
    steps: [{ kind: "linkedGroup", libraryId: "A", groupId: "g1" }],
    uncovered: [{ kind: "library", group: { id: "g1", name: "眼睛参考" }, libraryId: "B", libraryName: "旧库" }],
  },
  estimate: {
    totalBytes: 30 * 1024 * 1024,
    newBytes: 2 * 1024 * 1024,
    originals: 12,
    newOriginals: 1,
    unavailable: [],
  },
  targetAvailable: true,
  targetFreeBytes: null,
};

/** 备份设置的假后端：两个已登记的图库，其余照 `replies`。 */
export const backend = (replies: Replies) => fakeBackend({ registered_libraries: registrations, ...replies });
