// 命令失败的原因（#355）：后端交来错误代码＋参数（`CommandError`），这里按界面语言取文案。
// 判断错误种类一律按 `code`，不比较文字。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n/instance";
import type { CommandError } from "../bindings/CommandError";
import type { UnavailableReason } from "../bindings/UnavailableReason";
import type { HotkeyFailure } from "../bindings/HotkeyFailure";
import type { StoredReason } from "../bindings/StoredReason";

export type { CommandError };
export type CommandErrorCode = CommandError["code"];

type Params = Record<string, string | number | CommandError>;
// 错误代码是运行时的值；每个代码都有文案由 commandError.test.ts 在类型检查时核对。
const t = (key: string, params?: Params): string =>
  (i18n.t as (key: string, options?: object) => string)(`errors:${key}`, params);

/** 参考图此刻取不到的原因。 */
export function unavailableReasonText(reason: UnavailableReason): string {
  switch (reason.kind) {
    case "libraryUnavailable":
      return t("unavailable.libraryUnavailable", { cause: describeCommandError(reason.cause) });
    case "libraryMissing":
      return t("unavailable.libraryMissing", { root: reason.root });
    default:
      return t(`unavailable.${reason.kind}`);
  }
}
const unavailable = unavailableReasonText;

/** 系统没能注册快捷键的原因。 */
export function hotkeyFailureText(failure: HotkeyFailure): string {
  return failure.kind === "refused" ? t("hotkey.refused", { detail: failure.detail }) : t(`hotkey.${failure.kind}`);
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
    case "system":
      return error.detail;
    case "organizeTimedOut":
      return t("organizeTimedOut", {
        libraries: error.libraries.map((name) => t("libraryName", { name })).join(t("librarySeparator")),
      });
    case "groupMembersUnavailable":
      return t("groupMembersUnavailable", {
        members: error.members
          .map((m) =>
            m.member === null
              ? unavailable(m.reason)
              : t("memberUnavailable", { member: m.member, reason: unavailable(m.reason) }),
          )
          .join(t("memberSeparator")),
      });
    case "shortcutUsedBy":
      return t("shortcutUsedBy", { action: t(`shortcutAction.${error.action}`) });
    case "captureSourceUnavailable":
      return unavailable(error.reason);
    case "settingsRollbackIncomplete":
      return t(error.journalKept ? "settingsRollbackJournalKept" : "settingsRollbackIncomplete", {
        cause: describeCommandError(error.cause),
        rollback: describeCommandError(error.rollback),
      });
    case "subscriptionSource":
      return error.reason.code === "status"
        ? i18n.t("subscriptions:reason.status", { status: error.reason.status })
        : i18n.t(`subscriptions:reason.${error.reason.code}`);
    case "shortcutUnavailable":
      return t("shortcutUnavailable", { reason: hotkeyFailureText(error.reason) });
    case "backupProblems":
      return error.problems.map(describeCommandError).join(t("problemSeparator"));
    case "checkTableMismatch":
      return t(error.sameContent ? "checkTableRowCount" : "checkTableMismatch", {
        table: error.table,
        snapshot: error.snapshot,
        restored: error.restored,
      });
    default: {
      const { code, ...params } = error as { code: string } & Params;
      if (!i18n.exists(`errors:${code}`)) return t("unknown", { code, raw: JSON.stringify(error) });
      // 由别的错误引起时（`cause`），先写出原因再拼进说明。
      const filled = Object.fromEntries(
        Object.entries(params).map(([name, value]) => [
          name,
          isCommandError(value) ? describeCommandError(value) : value,
        ]),
      );
      return t(code, filled);
    }
  }
}

/**
 * 命令失败时抛出的错误：`code` 供判断，`message` 是按界面语言写好的说明。
 * 界面显示错误一律走 {@link errorText}。
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

/** 几个原因连成一句，例如自动标签跳过各个模型的原因。 */
export function describeCommandErrors(errors: CommandError[]): string {
  return errors.map(describeCommandError).join(t("reasonSeparator"));
}

/** 写进文件的原因：新记录是错误代码，旧版本写下的中文句子照原样显示。 */
export function storedReasonText(reason: StoredReason): string {
  return typeof reason === "string" ? reason : describeCommandError(reason);
}

/** 非命令失败的错误（插件调用、前端异常）在日志里的原文。 */
function rawText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 界面上显示错误的唯一出口（#483）：命令失败按代码取文案；其他错误只显示通用说明，
 * 原文写进运行日志。界面代码不直接 `String(e)`，由 src/ipc/errorTextUsage.test.ts 把关。
 */
export function errorText(error: unknown): string {
  if (error instanceof CommandFailure) return error.message;
  if (isCommandError(error)) return describeCommandError(error);
  // 忽略失败：写日志本身失败时没有别处可记。
  void tauriInvoke("log_frontend", { level: "error", message: `Unexpected error: ${rawText(error)}` }).catch(() => {});
  return t("generic");
}
