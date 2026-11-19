import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(join(directory, "nested"))).toEqual(["state.json"]);
  });

  it("skips the directory sync on Windows after writing the JSON file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const beforeDirectorySync = vi.fn(() => {
      throw new Error("directory sync is not supported");
    });
    __setAtomicFileTestHooks({ beforeDirectorySync });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(writeJsonAtomic(path, { value: "saved" })).resolves.toBeUndefined();
    } finally {
      platform.mockRestore();
    }

    expect(await readFile(path, "utf8")).toBe('{\n  "value": "saved"\n}\n');
    expect(beforeDirectorySync).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("syncs the parent directory on POSIX", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const beforeDirectorySync = vi.fn();
    __setAtomicFileTestHooks({ beforeDirectorySync });

    await writeJsonAtomic(path, { value: "saved" });

    expect(beforeDirectorySync).toHaveBeenCalledExactlyOnceWith(directory);
  });

  it.skipIf(process.platform === "win32")("rejects a directory sync failure on POSIX", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state.json");
    const failure = new Error("directory sync failed");
    const beforeDirectorySync = vi.fn(() => {
      throw failure;
    });
    __setAtomicFileTestHooks({ beforeDirectorySync });

    await expect(writeJsonAtomic(path, { value: "saved" })).rejects.toBe(failure);
    expect(beforeDirectorySync).toHaveBeenCalledExactlyOnceWith(directory);
  });
});

describe("withFileLock", () => {
  it("rejects a Windows candidate tomb unlink failure without leaving its own record", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    await writeFile(
      `${lockPath}.stale.released`,
      JSON.stringify({ pid: process.pid, token: "released-owner", released: true }),
      "utf8",
    );
    const failure = Object.assign(new Error("tomb unlink failed"), { code: "EPERM" });
    let owner = "";
    const beforeTombUnlink = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    __setAtomicFileTestHooks({
      afterLockCreate: async () => {
        owner = await readFile(lockPath, "utf8");
      },
      beforeTombUnlink,
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(withFileLock(lockPath, async () => undefined, { timeoutMs: 0 })).rejects.toBe(
        failure,
      );
      expect(beforeTombUnlink).toHaveBeenCalledTimes(1);
      expect(owner).not.toBe("");
      const records = await Promise.all(
        (await readdir(directory)).map((entry) => readFile(join(directory, entry), "utf8")),
      );
      expect(records).not.toContain(owner);
      await expect(withFileLock(lockPath, async () => "acquired again")).resolves.toBe(
        "acquired again",
      );
      expect(await readdir(directory)).toEqual([]);
    } finally {
      platform.mockRestore();
    }
  });

  it("removes its own tomb on outer timeout without changing another live owner's lock", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const otherOwner = JSON.stringify({ pid: process.pid, token: "other" });
    const now = Date.now();
    let attempts = 0;
    let owner = "";
    __setAtomicFileTestHooks({
      afterLockCreate: async () => {
        if (owner !== "") return;
        owner = await readFile(lockPath, "utf8");
        await writeFile(`${lockPath}.stale.own`, owner, "utf8");
      },
      beforeLockAttempt: async () => {
        attempts += 1;
        if (attempts !== 2) return;
        await writeFile(lockPath, otherOwner, { encoding: "utf8", flag: "wx" });
        vi.setSystemTime(now + 1_000);
      },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      await expect(
        withFileLock(lockPath, async () => undefined, { timeoutMs: 100 }),
      ).rejects.toBeInstanceOf(FileLockedError);
      expect(attempts).toBe(2);
      expect(owner).not.toBe("");
      expect((await readdir(directory)).filter((entry) => entry.includes(".stale."))).toEqual([]);
      expect(await readFile(lockPath, "utf8")).toBe(otherOwner);
      await rm(lockPath);
      await expect(
        withFileLock(lockPath, async () => "acquired again", { timeoutMs: 0 }),
      ).resolves.toBe("acquired again");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the returned value and releases the lock when its release marker fails", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const value = { saved: true };
    const beforeLockRelease = vi.fn(() => {
      throw new Error("release marker failed");
    });
    __setAtomicFileTestHooks({ beforeLockRelease });

    await expect(withFileLock(lockPath, async () => value)).resolves.toBe(value);
    expect(beforeLockRelease).toHaveBeenCalledExactlyOnceWith(lockPath);
    expect(await readdir(directory)).toEqual([]);
    await expect(
      withFileLock(lockPath, async () => "acquired again", { timeoutMs: 0 }),
    ).resolves.toBe("acquired again");
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves the operation error when its lock release marker also fails", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const operationError = new Error("operation failed");
    const beforeLockRelease = vi.fn(() => {
      throw new Error("release marker failed");
    });
    __setAtomicFileTestHooks({ beforeLockRelease });

    await expect(
      withFileLock(lockPath, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(beforeLockRelease).toHaveBeenCalledExactlyOnceWith(lockPath);
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves the returned value and removes the lock when closing its handle fails", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const value = { saved: true };
    const afterLockHandleClose = vi.fn(() => {
      throw new Error("lock handle close failed");
    });
    __setAtomicFileTestHooks({ afterLockHandleClose });

    await expect(withFileLock(lockPath, async () => value)).resolves.toBe(value);
    expect(afterLockHandleClose).toHaveBeenCalledExactlyOnceWith(lockPath);
    expect(await readdir(directory)).toEqual([]);
    await expect(
      withFileLock(lockPath, async () => "acquired again", { timeoutMs: 0 }),
    ).resolves.toBe("acquired again");
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves the operation error and removes the lock when closing its handle fails", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const operationError = new Error("operation failed");
    const afterLockHandleClose = vi.fn(() => {
      throw new Error("lock handle close failed");
    });
    __setAtomicFileTestHooks({ afterLockHandleClose });

    await expect(
      withFileLock(lockPath, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(afterLockHandleClose).toHaveBeenCalledExactlyOnceWith(lockPath);
    expect(await readdir(directory)).toEqual([]);
    await expect(
      withFileLock(lockPath, async () => "acquired again", { timeoutMs: 0 }),
    ).resolves.toBe("acquired again");
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves the returned value and marks the tomb released when removal fails", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const value = { saved: true };
    const beforeTombUnlink = vi.fn().mockImplementationOnce(() => {
      throw new Error("tomb unlink failed");
    });
    __setAtomicFileTestHooks({ beforeTombUnlink });

    await expect(withFileLock(lockPath, async () => value)).resolves.toBe(value);
    expect(beforeTombUnlink).toHaveBeenCalledTimes(1);
    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^state\.lock\.stale\./);
    expect(JSON.parse(await readFile(join(directory, entries[0]!), "utf8"))).toEqual({
      pid: process.pid,
      token: expect.any(String),
      released: true,
    });
    await expect(withFileLock(lockPath, async () => "acquired again")).resolves.toBe(
      "acquired again",
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves the operation error and marks the tomb released when removal fails", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const operationError = new Error("operation failed");
    const beforeTombUnlink = vi.fn().mockImplementationOnce(() => {
      throw new Error("tomb unlink failed");
    });
    __setAtomicFileTestHooks({ beforeTombUnlink });

    await expect(
      withFileLock(lockPath, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(beforeTombUnlink).toHaveBeenCalledTimes(1);
    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^state\.lock\.stale\./);
    expect(JSON.parse(await readFile(join(directory, entries[0]!), "utf8"))).toEqual({
      pid: process.pid,
      token: expect.any(String),
      released: true,
    });
    await expect(withFileLock(lockPath, async () => "acquired again")).resolves.toBe(
      "acquired again",
    );
    expect(await readdir(directory)).toEqual([]);
  });

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
