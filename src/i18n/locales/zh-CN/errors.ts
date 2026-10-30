import library from "./errors/library";
import domain from "./errors/domain";
import shell from "./errors/shell";
import reasons from "./errors/reasons";
import tagging from "./errors/tagging";

/** 命令失败时的说明（#355）：键是后端 `CommandError` 的 `code`，参数同名。见 `src/ipc/commandError.ts`。 */
export default {
  ...library,
  ...domain,
  ...shell,
  ...reasons,
  ...tagging,
};
