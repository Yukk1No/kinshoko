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

/**
 * 程序设置的统一改动命令（#527）按改的是哪一项分开：`change_setting` 带 `{ change: { kind: "forceSrgb", on } }`
 * 时，回答与记录都用 `change_setting:forceSrgb`，参数是这项改动除 `kind` 以外的字段（`{ on }`）。
 */
function route(name: string, args: Args): { name: string; args: Args } {
  if (name !== "change_setting") return { name, args };
  const { kind, ...fields } = args.change as { kind: string } & Args;
  return { name: `change_setting:${kind}`, args: fields };
}

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
    wallDensity: 240,
    updateChannel: "stable",
    ...overrides,
  } satisfies ShellSettingsView;
}

function isSettingsView(value: unknown): value is ShellSettingsView {
  return typeof value === "object" && value !== null && Array.isArray((value as ShellSettingsView).shortcuts);
}

/** 测试用的假后端：按命令名登记回答。命令名带不带 `plugin:…|` 前缀都认；改设置的命令见 `route`。 */
export function fakeBackend(replies: Replies = {}): FakeBackend {
  const table = new Map<string, AnyReply>();
  const log: Call[] = [];
  const on = (command: string, reply: AnyReply) => {
    table.set(bare(command), reply);
  };
  on("shell_settings", () => shellSettings());
  on("safe_mode", true);
  on("interface_language_choice", "system");
  on("workspace_status", { revision: "r1", libraries: [] } satisfies WorkspaceStatus);
  // 暂停、恢复快捷键回的是当前设置：取最近一次回给前端的那份。
  let settings: unknown;
  on("set_shortcuts_paused", () => settings);
  for (const [command, reply] of Object.entries(replies)) on(command, reply);
  mockWindows("main");
  mockIPC(
    async (command, args) => {
      const { name, args: given } = route(bare(command), (args ?? {}) as Args);
      log.push({ command: name, args: given });
      if (!table.has(name)) throw new Error(`fake backend: no reply for ${name}`);
      const reply = table.get(name);
      const result = await (typeof reply === "function" ? reply(given) : reply);
      if (isSettingsView(result)) settings = result;
      // 浏览与目录的回应嵌着完整工作区状态快照（useBrowseResults 会把它接受进状态镜像）。用例写页时
      // 往往只关心修订号、把登记列表留空；后端不会在有登记时回报空列表，这里按当下的登记回答补齐（#780）。
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const status = (result as Record<string, unknown>).status;
        if (status && typeof status === "object" && !Array.isArray(status)) {
          const shape = status as { libraries?: unknown };
          if (Array.isArray(shape.libraries) && shape.libraries.length === 0 && table.has("registered_libraries")) {
            const registrationReply = table.get("registered_libraries");
            const registrations = await (typeof registrationReply === "function"
              ? registrationReply({})
              : registrationReply);
            if (Array.isArray(registrations))
              return { ...(result as Record<string, unknown>), status: { ...shape, libraries: registrations } };
          }
        }
      }
      return result;
    },
    { shouldMockEvents: true },
  );
  return {
    on,
    calls: (command) => (command === undefined ? [...log] : log.filter((call) => call.command === bare(command))),
  };
}
