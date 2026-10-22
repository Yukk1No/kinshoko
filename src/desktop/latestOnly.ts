/** 只发最新的一次：上一次还没返回时，新的请求替换排队中的那个。拖动时不会积压 IPC。 */
export function latestOnly<A extends unknown[]>(send: (...args: A) => Promise<unknown>) {
  let busy = false;
  let queued: A | null = null;
  const run = (...args: A) => {
    if (busy) {
      queued = args;
      return;
    }
    busy = true;
    void send(...args)
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (queued) {
          const next = queued;
          queued = null;
          run(...next);
        }
      });
  };
  return run;
}
