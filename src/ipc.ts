// 前端调用 Tauri 命令的唯一入口。参数与返回值的类型来自 ts-rs 生成的 ./bindings，
// 不在这里手写；Rust 侧改了类型，重新生成后这里会在类型检查时报错。
import { invoke } from "@tauri-apps/api/core";
import type { AppInfo } from "./bindings/AppInfo";

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}
