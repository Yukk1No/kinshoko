/**
 * 程序设置的提交模型（#321）：设置页的每次改动都交成一条命令，由这里决定执行次序、合并与接受哪份快照。
 *
 * - 写入次序：命令按提交顺序一次只执行一条，上一条回来才发下一条。核心每条命令都回整份设置，
 *   所以回来的快照总是“到这条为止”的结果，旧返回不会盖过之后接受的设置，跨项改动也不会相互回滚。
 * - 合并：`latest` 项还没开始执行的同项命令换成最新这条，提交它们的调用方一起等这条的结果；
 *   `keep` 项每条都执行，不丢。
 * - 读取与整份替换（恢复备份）同样排进队列：之前提交的写入先完成，之后提交的写入在它之上执行；
 *   整份替换不被合并越过，成功后代次加一，设置页据此重新挂载各分区。
 * - 失败：接受的快照不变（核心保证原来的设置不变），原因记进错误；`dropPendingOnFailure` 的项
 *   连同排着的同项命令一并作废，它们是在失败那次之上改的。
 */

export type MergePolicy = "keep" | "latest";

export type SettingsCommand<View> = {
  /** 同一项设置的命令共用一个 key；合并只发生在同 key 之间。 */
  key: string;
  merge: MergePolicy;
  dropPendingOnFailure?: boolean;
  /** 整份替换设置：成功后代次加一，此后提交的命令不与它之前的合并。 */
  replaces?: boolean;
  /** 失败原因由调用方自己显示，不进共享的错误；成功也不清除它。 */
  quiet?: boolean;
  run: () => Promise<View>;
};

export type SubmitResult = { ok: true } | { ok: false; reason: unknown };

export type SubmitterState<View> = {
  /** 已接受的快照；还没读到时为 null。 */
  view: View | null;
  error: string | null;
  /** 整份替换的次数。 */
  generation: number;
};

type Entry<View> = { command: SettingsCommand<View>; settle: ((result: SubmitResult) => void)[] };

export type SettingsSubmitter<View> = {
  submit: (command: SettingsCommand<View>) => Promise<SubmitResult>;
  state: () => SubmitterState<View>;
  subscribe: (listener: () => void) => () => void;
  /** 设置页别处的错误（例如诊断、标签分组）共用同一条提示；null 为清除。 */
  showError: (error: string | null) => void;
};

export function createSettingsSubmitter<View>(options: {
  /** 每接受一份快照调用一次，按接受的顺序。 */
  onAccepted?: (view: View, command: SettingsCommand<View>) => void;
  describe?: (reason: unknown) => string;
} = {}): SettingsSubmitter<View> {
  const describe = options.describe ?? String;
  let state: SubmitterState<View> = { view: null, error: null, generation: 0 };
  const listeners = new Set<() => void>();
  const queue: Entry<View>[] = [];
  let running = false;

  const update = (patch: Partial<SubmitterState<View>>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  /** 队尾往前、不隔着整份替换的同项命令：新提交的命令与它们合并。 */
  const pendingSame = (key: string) => {
    const found: number[] = [];
    for (let i = queue.length - 1; i >= 0 && !queue[i].command.replaces; i--) {
      if (queue[i].command.key === key) found.push(i);
    }
    return found;
  };

  /** 队首往后、在下一次整份替换之前的同项命令（下标从大到小）：它们排在刚失败的那条之后，在它之上改。 */
  const dependentSame = (key: string) => {
    const found: number[] = [];
    for (let i = 0; i < queue.length && !queue[i].command.replaces; i++) {
      if (queue[i].command.key === key) found.unshift(i);
    }
    return found;
  };

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const entry = queue.shift()!;
      const { command } = entry;
      let view: View;
      try {
        view = await command.run();
      } catch (reason) {
        if (!command.quiet) update({ error: describe(reason) });
        const settles = [...entry.settle];
        if (command.dropPendingOnFailure) {
          for (const index of dependentSame(command.key)) settles.push(...queue.splice(index, 1)[0].settle);
        }
        for (const settle of settles) settle({ ok: false, reason });
        continue;
      }
      update({
        view,
        error: command.quiet ? state.error : null,
        generation: command.replaces ? state.generation + 1 : state.generation,
      });
      options.onAccepted?.(view, command);
      for (const settle of entry.settle) settle({ ok: true });
    }
    running = false;
  }

  return {
    submit(command) {
      return new Promise((resolve) => {
        if (command.merge === "latest") {
          const [index] = pendingSame(command.key);
          if (index !== undefined) {
            queue[index].command = command;
            queue[index].settle.push(resolve);
            return;
          }
        }
        queue.push({ command, settle: [resolve] });
        void drain();
      });
    },
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    showError(error) {
      if (error !== state.error) update({ error });
    },
  };
}
