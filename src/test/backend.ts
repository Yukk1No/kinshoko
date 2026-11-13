// 测试用的假后端（#520）：前端到后端只有 src/ipc/invoke.ts 一处接缝，这里是它在测试里的另一个适配器。
// 测试仍然经过真实的 src/ipc 包装与错误转换，只是 Tauri 的 invoke 换成按命令名查表回答。
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";

export type Args = Record<string, unknown>;
export type Reply<T> = T | ((args: Args) => T | Promise<T>);

/** 有固定返回类型的命令写在这张表里，类型取自 src/bindings。迁到哪个命令，就把哪个命令加进来。 */
export type Known = {
  shell_settings: ShellSettingsView;
  safe_mode: boolean;
  workspace_status: WorkspaceStatus;
};
/** 不在 `Known` 里的命令：回答任意值（不能是 `undefined`），或按参数算出回答的函数。 */
export type AnyReply = string | number | boolean | null | object | ((args: Args) => unknown);
export type Replies = { [K in keyof Known]?: Reply<Known[K]> } & Record<string, AnyReply>;

export type Call = { command: string; args: Args };
export type FakeBackend = {
  /** 登记或替换一条回答；测试中途可以再调用。 */
  on<K extends keyof Known>(command: K, reply: Reply<Known[K]>): void;
  on(command: string, reply: AnyReply): void;
  /** 收到过的调用，按先后；给了命令名就只看那一条命令的。 */
  calls(command?: string): Call[];
};

/** 命令名去掉插件前缀：`plugin:library|browse` 与 `browse` 是同一条。 */
const bare = (command: string) => command.replace(/^plugin:[^|]+\|/, "");

/** 一份完整的默认设置；测试只改自己关心的字段。 */
export function shellSettings(overrides: Partial<ShellSettingsView> = {}): ShellSettingsView {
  return {
    autostart: false,
    shortcuts: [],
    showApproxSource: false,
    forceSrgb: false,
    forceSrgbInEffect: false,
    runLog: false,
    keepSelectionOnSafeMode: false,
    pinEdgeContrast: false,
    safeModeScope: "questionable",
    tagDisplay: { style: "bands", high: 0.8, low: 0.4 },
    inspectorOpen: false,
    updateChannel: "stable",
    ...overrides,
  } satisfies ShellSettingsView;
}

/** 测试用的假后端：按命令名登记回答。命令名带不带 `plugin:…|` 前缀都认。 */
export function fakeBackend(replies: Replies = {}): FakeBackend {
  const table = new Map<string, AnyReply>();
  const log: Call[] = [];
  const on = (command: string, reply: AnyReply) => { table.set(bare(command), reply); };
  on("shell_settings", () => shellSettings());
  on("safe_mode", true);
  on("workspace_status", { revision: "r1", libraries: [] } satisfies WorkspaceStatus);
  for (const [command, reply] of Object.entries(replies)) on(command, reply);
  mockWindows("main");
  mockIPC(async (command, args) => {
    const name = bare(command);
    const given = (args ?? {}) as Args;
    log.push({ command: name, args: given });
    if (!table.has(name)) throw new Error(`fake backend: no reply for ${name}`);
    const reply = table.get(name);
    return typeof reply === "function" ? reply(given) : reply;
  }, { shouldMockEvents: true });
  return {
    on,
    calls: (command) => command === undefined ? [...log] : log.filter((call) => call.command === bare(command)),
  };
}
