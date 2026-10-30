/** One active refresh, with one follow-up shared by callers waiting for fresher data. */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  let queued: { resolve: () => void; reject: (reason: unknown) => void }[] = [];

  async function drain() {
    inFlight = true;
    while (queued.length > 0) {
      const callers = queued;
      queued = [];
      try {
        await run();
        for (const caller of callers) caller.resolve();
      } catch (error) {
        for (const caller of callers) caller.reject(error);
      }
    }
    inFlight = false;
  }

  return () =>
    new Promise<void>((resolve, reject) => {
      queued.push({ resolve, reject });
      if (!inFlight) void drain();
    });
}
