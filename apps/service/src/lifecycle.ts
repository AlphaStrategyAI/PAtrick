/** In-process ownership only. Cancellation requests stop, while join observes actual completion. */
export function createTaskLifetime(callerSignal?: AbortSignal) {
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  const pending = new Set<Promise<unknown>>();
  const errors: Array<{ code: string }> = [];
  function recordError() {
    if (errors.length < 16) errors.push({ code: 'ASYNC_TASK_FAILED' });
  }
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    void task.then(() => pending.delete(task), () => {
      pending.delete(task);
      recordError();
    });
    return task;
  }
  async function join(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending]);
  }
  function run<T>(start: () => Promise<T>) { return track(Promise.resolve().then(start)); }
  return {
    signal, track, run, join, errors, recordError,
    stop() { controller.abort(); },
    get active() { return pending.size; },
  };
}

export type WorkerLifetime = Pick<ReturnType<typeof createTaskLifetime>, 'stop' | 'join' | 'errors' | 'active'>;
