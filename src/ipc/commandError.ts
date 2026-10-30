// 命令失败的原因（#355）：后端交来错误代码＋参数（`CommandError`），这里按界面语言取文案。
// 判断错误种类一律按 `code`，不比较文字。
import { i18n } from "../i18n/instance";
import type { CommandError } from "../bindings/CommandError";
import type { UnavailableReason } from "../bindings/UnavailableReason";

export type { CommandError };
export type CommandErrorCode = CommandError["code"];

type Params = Record<string, string | number>;
// 错误代码是运行时的值；每个代码都有文案由 commandError.test.ts 在类型检查时核对。
const t = (key: string, params?: Params): string => (i18n.t as (key: string, options?: object) => string)(`errors:${key}`, params);

function unavailable(reason: UnavailableReason): string {
  return reason.kind === "libraryUnavailable" ? t("unavailable.libraryUnavailable", { detail: reason.detail }) : t(`unavailable.${reason.kind}`);
}

/** 后端交来的值是不是 `CommandError`。 */
function isCommandError(value: unknown): value is CommandError {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}

/** 按界面语言写出的说明。前端不认识的代码显示通用说明，并附原始信息便于反馈。 */
export function describeCommandError(error: CommandError): string {
  switch (error.code) {
    case "message":
      return error.message;
    case "organizeTimedOut":
      return t("organizeTimedOut", { libraries: error.libraries.map((name) => t("libraryName", { name })).join(t("librarySeparator")) });
    case "groupMembersUnavailable":
      return t("groupMembersUnavailable", { members: error.members.join(t("memberSeparator")) });
    case "shortcutUsedBy":
      return t("shortcutUsedBy", { action: t(`shortcutAction.${error.action}`) });
    case "captureSourceUnavailable":
      return unavailable(error.reason);
    default: {
      const { code, cause, ...params } = error as { code: string; cause?: CommandError } & Params;
      if (!i18n.exists(`errors:${code}`)) return t("unknown", { code, raw: JSON.stringify(error) });
      // 包着下层原因的错误：原因也按代码取文案。
      return t(code, cause ? { ...params, cause: describeCommandError(cause) } : params);
    }
  }
}

/**
 * 命令失败时抛出的错误：`code` 供判断，`message` 是按界面语言写好的说明。
 * `String(error)` 也得到说明，界面里原来直接显示错误的地方不用改。
 */
export class CommandFailure extends Error {
  readonly code: CommandErrorCode;
  readonly error: CommandError;

  constructor(error: CommandError) {
    super(describeCommandError(error));
    this.name = "CommandFailure";
    this.code = error.code;
    this.error = error;
  }

  override toString(): string {
    return this.message;
  }
}

/** 命令被拒绝时的原因：后端的 `CommandError` 换成 {@link CommandFailure}，其他原样交回。 */
export function commandFailure(reason: unknown): unknown {
  return isCommandError(reason) ? new CommandFailure(reason) : reason;
}

/** 错误代码；不是命令失败（或没有代码）时为 `undefined`。 */
export function errorCode(error: unknown): string | undefined {
  if (error instanceof CommandFailure) return error.code;
  return isCommandError(error) ? error.code : undefined;
}

/** 失败是不是这种错误。 */
export function isErrorCode(error: unknown, code: CommandErrorCode): boolean {
  return errorCode(error) === code;
}

/** 给画师看的说明：命令失败按代码取文案，其他错误按原样。 */
export function errorText(error: unknown): string {
  if (isCommandError(error)) return describeCommandError(error);
  return String(error);
}
