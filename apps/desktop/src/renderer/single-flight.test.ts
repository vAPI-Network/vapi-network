import { describe, expect, it, vi } from "vitest";

import { singleFlight } from "./single-flight.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("queues one follow-up for three callers and waits for fresh data", async () => {
    const first = deferred();
    const second = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const refresh = singleFlight(run);
    const initial = refresh();
    const finished = vi.fn();
    const queued = [refresh(), refresh(), refresh()];
    const followUp = Promise.all(queued).then(finished);

    expect(run).toHaveBeenCalledTimes(1);
    first.resolve();
    await initial;
    expect(run).toHaveBeenCalledTimes(2);
    expect(finished).not.toHaveBeenCalled();

    second.resolve();
    await followUp;
    expect(finished).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives callers arriving during the follow-up another fresh run", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const run = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const refresh = singleFlight(run);
    const initial = refresh();
    const followUp = refresh();
    first.resolve();
    await initial;

    const finished = vi.fn();
    const later = refresh().then(finished);
    expect(run).toHaveBeenCalledTimes(2);
    second.resolve();
    await followUp;
    expect(run).toHaveBeenCalledTimes(3);
    expect(finished).not.toHaveBeenCalled();
    third.resolve();
    await later;
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed run but still finishes the follow-up and resets", async () => {
    const first = deferred();
    const second = deferred();
    const run = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(undefined);
    const refresh = singleFlight(run);
    const initial = expect(refresh()).rejects.toThrow("offline");
    const followUp = refresh();
    first.reject(new Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    await initial;

    second.resolve();
    await followUp;
    await refresh();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
