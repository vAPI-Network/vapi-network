import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  __setAtomicFileTestHooks,
  FileLockedError,
  withFileLock,
  writeJsonAtomic,
} from "./atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  __setAtomicFileTestHooks(undefined);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-atomic-file-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("writeJsonAtomic", () => {
  it("writes a mode-0600 JSON file and leaves no temporary file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested", "state.json");

    await writeJsonAtomic(path, { value: "saved" });

    expect(await readFile(path, "utf8")).toBe('{\n  "value": "saved"\n}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, "nested"))).toEqual(["state.json"]);
  });
});

describe("withFileLock", () => {
  it("does not remove a fresh lock during concurrent stale-lock takeover", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }), "utf8");
    const staleTime = new Date(Date.now() - 180_000);
    await utimes(lockPath, staleTime, staleTime);

    let staleBreaks = 0;
    let resumePausedBreak!: () => void;
    let reportPausedBreak!: () => void;
    let resumeRestore!: () => void;
    let reportFreshLockRenamed!: () => void;
    let reportFreshLockRestored!: () => void;
    let reportThirdLockCreated!: () => void;
    let thirdStarted = false;
    const pausedBreak = new Promise<void>((resolve) => {
      reportPausedBreak = resolve;
    });
    const mayResumePausedBreak = new Promise<void>((resolve) => {
      resumePausedBreak = resolve;
    });
    const freshLockRenamed = new Promise<void>((resolve) => {
      reportFreshLockRenamed = resolve;
    });
    const mayRestoreFreshLock = new Promise<void>((resolve) => {
      resumeRestore = resolve;
    });
    const freshLockRestored = new Promise<void>((resolve) => {
      reportFreshLockRestored = resolve;
    });
    const thirdLockCreated = new Promise<void>((resolve) => {
      reportThirdLockCreated = resolve;
    });
    __setAtomicFileTestHooks({
      afterLockCreate: () => {
        if (thirdStarted) reportThirdLockCreated();
      },
      beforeStaleLockBreak: async () => {
        staleBreaks += 1;
        if (staleBreaks !== 1) return;
        reportPausedBreak();
        await mayResumePausedBreak;
      },
      afterMismatchedLockRename: async () => {
        reportFreshLockRenamed();
        await mayRestoreFreshLock;
      },
      afterMismatchedLockRestore: () => {
        reportFreshLockRestored();
      },
      isProcessAlive: () => false,
    });

    let inside = 0;
    let maximumInside = 0;
    let reportSecondEntered!: () => void;
    let releaseSecond!: () => void;
    let releaseThird!: () => void;
    const secondEntered = new Promise<void>((resolve) => {
      reportSecondEntered = resolve;
    });
    const secondMayFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const thirdMayFinish = new Promise<void>((resolve) => {
      releaseThird = resolve;
    });
    const enter = (): void => {
      inside += 1;
      maximumInside = Math.max(maximumInside, inside);
    };

    const first = withFileLock(lockPath, async () => {
      enter();
      inside -= 1;
    });
    await pausedBreak;

    const second = withFileLock(lockPath, async () => {
      enter();
      reportSecondEntered();
      await secondMayFinish;
      inside -= 1;
    });
    await secondEntered;
    const freshOwner = await readFile(lockPath, "utf8");

    resumePausedBreak();
    await freshLockRenamed;

    thirdStarted = true;
    const third = withFileLock(lockPath, async () => {
      enter();
      await thirdMayFinish;
      inside -= 1;
    });
    await thirdLockCreated;
    resumeRestore();
    await freshLockRestored;
    const thirdEnteredBeforeRelease = inside > 1;
    const freshLockPreserved = await readFile(lockPath, "utf8")
      .then((owner) => owner === freshOwner)
      .catch(() => false);

    releaseSecond();
    releaseThird();
    await Promise.all([first, second, third]);
    const tombs = (await readdir(directory)).filter((name) => name.startsWith("state.lock.stale."));

    expect({ freshLockPreserved, maximumInside, thirdEnteredBeforeRelease, tombs }).toEqual({
      freshLockPreserved: true,
      maximumInside: 1,
      thirdEnteredBeforeRelease: false,
      tombs: [],
    });
  });

  it("reaps a stale takeover tomb abandoned by a crashed contender", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const tombPath = `${lockPath}.stale.abandoned`;
    await writeFile(tombPath, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }), "utf8");
    const staleTime = new Date(Date.now() - 180_000);
    await utimes(tombPath, staleTime, staleTime);
    __setAtomicFileTestHooks({ isProcessAlive: () => false });

    let entered = false;
    await withFileLock(lockPath, async () => {
      entered = true;
    });

    expect({ entered, entries: await readdir(directory) }).toEqual({ entered: true, entries: [] });
  });

  it("keeps a fresh takeover tomb as an acquisition barrier", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const tombPath = `${lockPath}.stale.active`;
    const owner = JSON.stringify({ pid: process.pid, token: "active-owner" });
    await writeFile(tombPath, owner, "utf8");

    await expect(
      withFileLock(lockPath, async () => undefined, { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(FileLockedError);

    expect(await readFile(tombPath, "utf8")).toBe(owner);
    expect(await readdir(directory)).toEqual(["state.lock.stale.active"]);
  });

  it("serializes two concurrent callers", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(lockPath, async () => {
      events.push("first:start");
      await firstMayFinish;
      events.push("first:end");
    });
    await expect.poll(() => events).toEqual(["first:start"]);

    const second = withFileLock(lockPath, async () => {
      events.push("second:start");
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("uses the supplied locked message when acquisition times out", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(lockPath, async () => await mayFinish);
    await expect.poll(async () => (await readdir(directory)).includes("state.lock")).toBe(true);

    try {
      await expect(
        withFileLock(lockPath, async () => undefined, {
          timeoutMs: 0,
          lockedMessage: "The state file is busy.",
        }),
      ).rejects.toEqual(new FileLockedError("The state file is busy."));
    } finally {
      release();
      await holder;
    }
  });
});
