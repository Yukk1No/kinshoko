// 调用 Tauri 命令。命令失败时，后端的错误代码换成带说明的 `CommandFailure`（#355）。
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { commandFailure } from "./commandError";

export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (reason) {
    throw commandFailure(reason);
  }
}
