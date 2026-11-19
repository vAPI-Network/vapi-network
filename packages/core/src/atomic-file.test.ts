import { mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  it("rejects a Windows displaced released tomb unlink failure without leaving its own record", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const otherOwner = JSON.stringify({ pid: process.pid, token: "other", released: true });
    const failure = Object.assign(new Error("displaced released tomb unlink failed"), {
      code: "EPERM",
    });
    let owner = "";
    let failedTomb: string | undefined;
    __setAtomicFileTestHooks({
      afterLockCreate: async () => {
        if (owner !== "") return;
        owner = await readFile(lockPath, "utf8");
        // Move the open candidate as a paused contender would, including on Windows.
        await rename(lockPath, `${lockPath}.stale.own`);
        await writeFile(lockPath, otherOwner, { encoding: "utf8", flag: "wx" });
      },
      beforeTombUnlink: async (tombPath) => {
        if (failedTomb !== undefined || (await readFile(tombPath, "utf8")) !== otherOwner) {
          return;
        }
        failedTomb = tombPath;
        throw failure;
      },
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(withFileLock(lockPath, async () => undefined, { timeoutMs: 0 })).rejects.toBe(
        failure,
      );
      expect(failedTomb).toBeDefined();
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

  it("rejects a Windows displaced released tomb unlink failure with four contenders", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const now = Date.now();
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }), "utf8");
    const staleTime = new Date(now - 180_000);
    await utimes(lockPath, staleTime, staleTime);

    function pausePoint() {
      let signal!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const mayResume = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return {
        reached,
        resume,
        pause: async () => {
          signal();
          await mayResume;
        },
      };
    }
    const firstBreak = pausePoint();
    const secondBreak = pausePoint();
    const ownerEntered = pausePoint();
    const ownerRenamed = pausePoint();
    const candidateCreated = pausePoint();
    const candidateRenamed = pausePoint();
    const ownerRestored = pausePoint();
    const ownerClosed = pausePoint();
    const candidateRestored = pausePoint();
    const pauses = [
      firstBreak,
      secondBreak,
      ownerEntered,
      ownerRenamed,
      candidateCreated,
      candidateRenamed,
      ownerRestored,
      ownerClosed,
      candidateRestored,
    ];
    const failure = Object.assign(new Error("four-contender released tomb unlink failed"), {
      code: "EPERM",
    });
    let staleBreaks = 0;
    let creates = 0;
    let renames = 0;
    let restores = 0;
    let closes = 0;
    let candidateOwner = "";
    let releasedOwner = "";
    let failedTomb: string | undefined;
    let candidateRetried = false;
    let candidateFinished = false;
    __setAtomicFileTestHooks({
      beforeStaleLockBreak: async () => {
        staleBreaks += 1;
        if (staleBreaks === 1) await firstBreak.pause();
        else if (staleBreaks === 2) await secondBreak.pause();
      },
      afterLockCreate: async () => {
        creates += 1;
        if (creates !== 2) return;
        candidateOwner = await readFile(lockPath, "utf8");
        await candidateCreated.pause();
      },
      afterMismatchedLockRename: async () => {
        renames += 1;
        if (renames === 1) await ownerRenamed.pause();
        else if (renames === 2) await candidateRenamed.pause();
      },
      afterMismatchedLockRestore: async () => {
        restores += 1;
        if (restores === 1) await ownerRestored.pause();
        else if (restores === 2) await candidateRestored.pause();
      },
      afterLockHandleClose: async () => {
        closes += 1;
        if (closes === 1) await ownerClosed.pause();
      },
      beforeTombUnlink: async (tombPath) => {
        if (releasedOwner === "" || failedTomb !== undefined) return;
        if ((await readFile(tombPath, "utf8")) !== releasedOwner) return;
        failedTomb = tombPath;
        throw failure;
      },
      beforeLockAttempt: async () => {
        if (failedTomb === undefined || candidateFinished || candidateRetried) return;
        // A regression retries: restore its own live record before its timeout.
        candidateRetried = true;
        candidateRenamed.resume();
        await candidateRestored.reached;
        vi.setSystemTime(now + 1_000);
      },
      isProcessAlive: (pid) => pid === process.pid,
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const first = withFileLock(lockPath, async () => "first");
    let second: Promise<string> | undefined;
    let owner: Promise<string> | undefined;
    let candidate: Promise<string> | undefined;
    try {
      await firstBreak.reached;
      second = withFileLock(lockPath, async () => "second");
      await secondBreak.reached;
      owner = withFileLock(lockPath, async () => {
        await ownerEntered.pause();
        return "owner";
      });
      await ownerEntered.reached;

      // Two stale readers displace the owner, then the new candidate.
      secondBreak.resume();
      await ownerRenamed.reached;
      candidate = withFileLock(lockPath, async () => "candidate", { timeoutMs: 100 });
      const candidateResult = candidate.catch((error: unknown) => error);
      await candidateCreated.reached;
      firstBreak.resume();
      await candidateRenamed.reached;
      ownerRenamed.resume();
      await ownerRestored.reached;

      // The owner releases its restored inode while both stale readers pause.
      ownerEntered.resume();
      await ownerClosed.reached;
      releasedOwner = await readFile(lockPath, "utf8");
      expect(JSON.parse(releasedOwner)).toMatchObject({ pid: process.pid, released: true });
      candidateCreated.resume();
      const result = await candidateResult;
      candidateFinished = true;
      const ownRecordAtLock =
        (await readFile(lockPath, "utf8").catch(() => undefined)) === candidateOwner;
      expect(
        result,
        `candidate retried: ${candidateRetried}; own record at lock: ${ownRecordAtLock}`,
      ).toBe(failure);
      expect(failedTomb).toBeDefined();
      expect(candidateRetried).toBe(false);
      expect(candidateOwner).not.toBe("");
      const records = await Promise.all(
        (await readdir(directory)).map((entry) => readFile(join(directory, entry), "utf8")),
      );
      expect(records).not.toContain(candidateOwner);

      for (const point of pauses) point.resume();
      await expect(Promise.all([first, second, owner])).resolves.toEqual([
        "first",
        "second",
        "owner",
      ]);
      expect(await readdir(directory)).toEqual([]);
      await expect(withFileLock(lockPath, async () => "acquired again")).resolves.toBe(
        "acquired again",
      );
      expect(await readdir(directory)).toEqual([]);
    } finally {
      candidateFinished = true;
      // On regression the timed-out candidate can leave its own live lock behind.
      if ((await readFile(lockPath, "utf8").catch(() => undefined)) === candidateOwner) {
        await rm(lockPath);
      }
      for (const point of pauses) point.resume();
      vi.useRealTimers();
      await Promise.allSettled([first, second, owner, candidate]);
      platform.mockRestore();
    }
  });

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
      expect(beforeTombUnlink).toHaveBeenCalledTimes(2);
      expect(beforeTombUnlink.mock.calls[1]).toEqual(beforeTombUnlink.mock.calls[0]);
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

  it("rejects a Windows unreleased tomb unlink failure during stale-lock takeover", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    const now = Date.now();
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }), "utf8");
    const staleTime = new Date(now - 180_000);
    await utimes(lockPath, staleTime, staleTime);

    let resumePausedBreak!: () => void;
    let reportPausedBreak!: () => void;
    let resumeCandidate!: () => void;
    let reportCandidateCreated!: () => void;
    let resumeRestore!: () => void;
    let reportCandidateRenamed!: () => void;
    const pausedBreak = new Promise<void>((resolve) => {
      reportPausedBreak = resolve;
    });
    const mayResumePausedBreak = new Promise<void>((resolve) => {
      resumePausedBreak = resolve;
    });
    const candidateCreated = new Promise<void>((resolve) => {
      reportCandidateCreated = resolve;
    });
    const mayResumeCandidate = new Promise<void>((resolve) => {
      resumeCandidate = resolve;
    });
    const candidateRenamed = new Promise<void>((resolve) => {
      reportCandidateRenamed = resolve;
    });
    const mayRestoreCandidate = new Promise<void>((resolve) => {
      resumeRestore = resolve;
    });
    const failure = Object.assign(new Error("unreleased tomb unlink failed"), { code: "EPERM" });
    let staleBreaks = 0;
    let owner = "";
    let failedTomb: string | undefined;
    const beforeTombUnlink = vi.fn(async (tombPath: string) => {
      if (failedTomb !== undefined || owner === "") return;
      if ((await readFile(tombPath, "utf8")) !== owner) return;
      failedTomb = tombPath;
      vi.setSystemTime(now + 1_000);
      throw failure;
    });
    __setAtomicFileTestHooks({
      beforeStaleLockBreak: async () => {
        staleBreaks += 1;
        if (staleBreaks !== 1) return;
        reportPausedBreak();
        await mayResumePausedBreak;
      },
      afterLockCreate: async () => {
        if (owner !== "") return;
        owner = await readFile(lockPath, "utf8");
        reportCandidateCreated();
        await mayResumeCandidate;
      },
      afterMismatchedLockRename: async () => {
        reportCandidateRenamed();
        await mayRestoreCandidate;
      },
      beforeTombUnlink,
      isProcessAlive: (pid) => pid === process.pid,
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const contenderB = withFileLock(lockPath, async () => "B");
    let contenderA: Promise<string> | undefined;
    try {
      await pausedBreak;
      contenderA = withFileLock(lockPath, async () => "A", { timeoutMs: 100 });
      await candidateCreated;
      resumePausedBreak();
      await candidateRenamed;
      resumeCandidate();

      await expect(contenderA).rejects.toBe(failure);
      expect(failedTomb).toBeDefined();
      expect(beforeTombUnlink.mock.calls.filter(([path]) => path === failedTomb)).toHaveLength(2);
      resumeRestore();
      await expect(contenderB).resolves.toBe("B");
      expect(await readdir(directory)).toEqual([]);
      await expect(
        withFileLock(lockPath, async () => "acquired again", { timeoutMs: 0 }),
      ).resolves.toBe("acquired again");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      resumePausedBreak();
      resumeCandidate();
      resumeRestore();
      await Promise.allSettled([contenderA, contenderB]);
      platform.mockRestore();
      vi.useRealTimers();
    }
  });

  it("tolerates a Windows released tomb unlink failure while waiting for a lock", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "released-owner", released: true }),
      "utf8",
    );
    const failure = Object.assign(new Error("released tomb unlink failed"), { code: "EPERM" });
    const beforeTombUnlink = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    __setAtomicFileTestHooks({ beforeTombUnlink });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(withFileLock(lockPath, async () => "acquired")).resolves.toBe("acquired");
      expect(beforeTombUnlink).toHaveBeenCalledTimes(3);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      platform.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a POSIX released tomb unlink failure and lets the next caller reap it",
    async () => {
      const directory = await temporaryDirectory();
      const lockPath = join(directory, "state.lock");
      const releasedOwner = JSON.stringify({
        pid: process.pid,
        token: "released-owner",
        released: true,
      });
      await writeFile(lockPath, releasedOwner, "utf8");
      const failure = Object.assign(new Error("released tomb unlink failed"), { code: "EPERM" });
      const beforeTombUnlink = vi.fn().mockImplementationOnce(() => {
        throw failure;
      });
      __setAtomicFileTestHooks({ beforeTombUnlink });

      await expect(withFileLock(lockPath, async () => "acquired")).rejects.toBe(failure);
      expect(beforeTombUnlink).toHaveBeenCalledTimes(1);
      const entries = await readdir(directory);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^state\.lock\.stale\./);
      expect(await readFile(join(directory, entries[0]!), "utf8")).toBe(releasedOwner);
      await expect(withFileLock(lockPath, async () => "acquired again")).resolves.toBe(
        "acquired again",
      );
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("tolerates a Windows released tomb unlink failure in the owner's sweep while a waiter waits", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "state.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }), "utf8");
    const staleTime = new Date(Date.now() - 180_000);
    await utimes(lockPath, staleTime, staleTime);

    let resumePausedBreak!: () => void;
    let reportPausedBreak!: () => void;
    let finishOwner!: () => void;
    let reportOwnerEntered!: () => void;
    let resumeStaleRemoval!: () => void;
    let reportOwnerRestored!: () => void;
    let resumeOwner!: () => void;
    let reportOwnerClosed!: () => void;
    let resumeWaiter!: () => void;
    let reportWaiterRenamed!: () => void;
    const pausedBreak = new Promise<void>((resolve) => {
      reportPausedBreak = resolve;
    });
    const mayResumePausedBreak = new Promise<void>((resolve) => {
      resumePausedBreak = resolve;
    });
    const ownerEntered = new Promise<void>((resolve) => {
      reportOwnerEntered = resolve;
    });
    const ownerMayFinish = new Promise<void>((resolve) => {
      finishOwner = resolve;
    });
    const ownerRestored = new Promise<void>((resolve) => {
      reportOwnerRestored = resolve;
    });
    const mayRemoveStaleTomb = new Promise<void>((resolve) => {
      resumeStaleRemoval = resolve;
    });
    const ownerClosed = new Promise<void>((resolve) => {
      reportOwnerClosed = resolve;
    });
    const mayResumeOwner = new Promise<void>((resolve) => {
      resumeOwner = resolve;
    });
    const waiterRenamed = new Promise<void>((resolve) => {
      reportWaiterRenamed = resolve;
    });
    const mayResumeWaiter = new Promise<void>((resolve) => {
      resumeWaiter = resolve;
    });
    const failure = Object.assign(new Error("released tomb sweep failed"), { code: "EPERM" });
    let staleBreaks = 0;
    let releasedOwner = "";
    let waiterStarted = false;
    let waiterTomb: string | undefined;
    let sweeping = false;
    const sweptTombs: string[] = [];
    const sweptRecords: string[] = [];
    const beforeTombUnlink = vi.fn(async (tombPath: string) => {
      if (waiterStarted && waiterTomb === undefined) {
        waiterTomb = tombPath;
        releasedOwner = await readFile(tombPath, "utf8");
        reportWaiterRenamed();
        await mayResumeWaiter;
      } else if (sweeping) {
        sweptTombs.push(tombPath);
        sweptRecords.push(await readFile(tombPath, "utf8"));
        if (sweptTombs.length === 1) throw failure;
      }
    });
    __setAtomicFileTestHooks({
      beforeStaleLockBreak: async () => {
        staleBreaks += 1;
        if (staleBreaks !== 1) return;
        reportPausedBreak();
        await mayResumePausedBreak;
      },
      afterMismatchedLockRestore: async () => {
        reportOwnerRestored();
        await mayRemoveStaleTomb;
      },
      afterLockHandleClose: async () => {
        reportOwnerClosed();
        await mayResumeOwner;
      },
      beforeTombUnlink,
      isProcessAlive: (pid) => pid === process.pid,
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const staleContender = withFileLock(lockPath, async () => "stale contender");
    const waiterOperation = vi.fn(async () => "waiter");
    let owner: Promise<string> | undefined;
    let waiter: Promise<string> | undefined;
    try {
      await pausedBreak;
      owner = withFileLock(lockPath, async () => {
        reportOwnerEntered();
        await ownerMayFinish;
        return "owner";
      });
      await ownerEntered;
      resumePausedBreak();
      await ownerRestored;
      // The restored lock and the stale contender's tomb share the owner's inode.
      // Releasing the lock marks both records, giving the sweep two released tombs.
      finishOwner();
      await ownerClosed;
      waiterStarted = true;
      waiter = withFileLock(lockPath, waiterOperation);
      await waiterRenamed;
      expect(JSON.parse(releasedOwner)).toMatchObject({ pid: process.pid, released: true });
      sweeping = true;
      resumeOwner();
      await expect(owner).resolves.toBe("owner");
      sweeping = false;
      expect(sweptTombs).toHaveLength(2);
      expect(new Set(sweptTombs).size).toBe(2);
      expect(sweptRecords).toEqual([releasedOwner, releasedOwner]);
      expect((await readdir(directory)).map((entry) => join(directory, entry))).toEqual([
        sweptTombs[0],
      ]);
      expect(waiterOperation).not.toHaveBeenCalled();
      resumeStaleRemoval();
      resumeWaiter();
      await expect(staleContender).resolves.toBe("stale contender");
      await expect(waiter).resolves.toBe("waiter");
      expect(waiterOperation).toHaveBeenCalledTimes(1);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      sweeping = false;
      resumePausedBreak();
      finishOwner();
      resumeStaleRemoval();
      resumeOwner();
      resumeWaiter();
      await Promise.allSettled([staleContender, owner, waiter]);
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
