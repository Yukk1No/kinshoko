import { invoke } from "./ipc/invoke";
import { CommandFailure } from "./ipc/commandError";

/** 每次界面加载最多记这么多条，出错循环时不挤掉别的日志。 */
const LIMIT = 100;

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * 界面无从提示、但排查要用的失败（#529）：记一条警告进运行日志。命令失败只记错误代码，
 * 其他错误记原文（同样由后端脱敏）。
 */
export function logFailure(what: string, reason: unknown): void {
  const detail = reason instanceof CommandFailure ? reason.code : describe(reason);
  // 忽略失败：写日志本身失败时没有别处可记。
  void invoke("log_frontend", { level: "warn", message: `${what}: ${detail}` }).catch(() => {});
}

/**
 * 把界面里没有接住的错误与被拒绝的 Promise 记进运行日志（#219）。文字由后端脱敏后才写入，
 * 不带调用栈（栈里的位置会被当成路径去掉）。返回撤销函数。
 */
export function recordUncaughtErrors(target: Window): () => void {
  let count = 0;
  const send = (message: string) => {
    if (++count > LIMIT) return;
    // 忽略失败：写日志本身失败时没有别处可记。
    void invoke("log_frontend", { level: "error", message }).catch(() => {});
  };
  const onError = (event: ErrorEvent) => send(event.message || describe(event.error));
  const onRejection = (event: PromiseRejectionEvent) => send(`Unhandled promise rejection: ${describe(event.reason)}`);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
