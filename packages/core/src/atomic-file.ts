import { randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_AFTER_MS = 120_000;
const LOCK_HEARTBEAT_MS = 30_000;

export interface WriteJsonAtomicOptions {
  mode?: number;
}

export interface FileLockOptions {
  timeoutMs?: number;
  lockedMessage?: string;
}

interface AtomicFileTestHooks {
  beforeLockAttempt?: (path: string) => void | Promise<void>;
  afterLockCreate?: (path: string) => void | Promise<void>;
  beforeStaleLockBreak?: (path: string) => void | Promise<void>;
  afterMismatchedLockRename?: (path: string) => void | Promise<void>;
  afterMismatchedLockRestore?: (path: string) => void | Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
}

let atomicFileTestHooks: AtomicFileTestHooks | undefined;

export function __setAtomicFileTestHooks(hooks: AtomicFileTestHooks | undefined): void {
  atomicFileTestHooks = hooks;
}

export class FileLockedError extends Error {
  constructor(message = "Timed out waiting for the file lock.") {
    super(message);
    this.name = "FileLockedError";
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);

    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const ownerRecord = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
  };
  const owner = JSON.stringify(ownerRecord);
  const releasedOwner = JSON.stringify({ ...ownerRecord, released: true });
  let handle: FileHandle | undefined;

  while (handle === undefined) {
    await atomicFileTestHooks?.beforeLockAttempt?.(lockPath);
    try {
      const candidate = await open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(owner, "utf8");
        await candidate.sync();
        await atomicFileTestHooks?.afterLockCreate?.(lockPath);
        if (await lockTakeoverInProgress(lockPath)) {
          await candidate.close();
          await removeOwnedLock(lockPath, [owner]);
          await removeAbandonedLockTombs(lockPath);
          if (Date.now() >= deadline) {
            throw new FileLockedError(options.lockedMessage);
          }
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
          continue;
        }
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await removeOwnedLock(lockPath, [owner]).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new FileLockedError(options.lockedMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  const ownedHandle = handle;
  const heartbeat = setInterval(() => {
    const time = new Date();
    void ownedHandle.utimes(time, time).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      await markLockReleased(ownedHandle, releasedOwner);
    } finally {
      try {
        await ownedHandle.close();
      } finally {
        await removeOwnedLock(lockPath, [owner, releasedOwner]);
      }
    }
  }
}

async function removeStaleLock(path: string): Promise<void> {
  try {
    const owner = await readFile(path, "utf8");
    if (lockOwnerReleased(owner)) {
      await removeOwnedLock(path, [owner]);
      return;
    }
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs <= LOCK_STALE_AFTER_MS) return;
    const pid = lockOwnerPid(owner);
    if (pid !== undefined && processIsAlive(pid)) return;
    await atomicFileTestHooks?.beforeStaleLockBreak?.(path);
    await removeOwnedLock(path, [owner]);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function removeOwnedLock(path: string, owners: readonly string[]): Promise<void> {
  const tombPath = `${path}.stale.${randomBytes(16).toString("hex")}`;
  try {
    await rename(path, tombPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      await removeOwnedTombs(path, owners);
      const currentOwner = await readFile(path, "utf8").catch(() => undefined);
      if (currentOwner !== undefined && owners.includes(currentOwner)) {
        await removeOwnedLock(path, owners);
      }
      return;
    }
    throw error;
  }

  let pendingError: unknown;
  try {
    const renamedOwner = await readFile(tombPath, "utf8");
    if (!owners.includes(renamedOwner) && !lockOwnerReleased(renamedOwner)) {
      await atomicFileTestHooks?.afterMismatchedLockRename?.(path);
      const currentOwner = await readFile(tombPath, "utf8");
      if (!lockOwnerReleased(currentOwner)) await restoreRenamedLock(path, tombPath);
      await atomicFileTestHooks?.afterMismatchedLockRestore?.(path);
    }
  } catch (error) {
    pendingError = error;
  }

  try {
    await unlink(tombPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && pendingError === undefined) {
      pendingError = error;
    }
  }
  if (pendingError !== undefined) throw pendingError;
}

async function lockTakeoverInProgress(path: string): Promise<boolean> {
  const prefix = `${basename(path)}.stale.`;
  return (await readdir(dirname(path))).some((entry) => entry.startsWith(prefix));
}

async function removeAbandonedLockTombs(path: string): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.stale.`;
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const tombPath = join(directory, entry);
    const [metadata, owner] = await Promise.all([
      stat(tombPath).catch(() => undefined),
      readFile(tombPath, "utf8").catch(() => undefined),
    ]);
    if (metadata === undefined || owner === undefined) continue;
    const pid = lockOwnerPid(owner);
    const abandoned =
      lockOwnerReleased(owner) ||
      (Date.now() - metadata.mtimeMs > LOCK_STALE_AFTER_MS &&
        (pid === undefined || !processIsAlive(pid)));
    if (!abandoned) continue;
    await unlink(tombPath).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

async function removeOwnedTombs(path: string, owners: readonly string[]): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.stale.`;
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const tombPath = join(directory, entry);
    const owner = await readFile(tombPath, "utf8").catch(() => undefined);
    if (owner === undefined || !owners.includes(owner)) continue;
    await unlink(tombPath).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

async function restoreRenamedLock(path: string, tombPath: string): Promise<void> {
  while (true) {
    try {
      await link(tombPath, path);
      return;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      if (!hasCode(error, "EEXIST")) throw error;
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function markLockReleased(handle: FileHandle, owner: string): Promise<void> {
  const contents = Buffer.from(owner, "utf8");
  await handle.write(contents, 0, contents.length, 0);
  await handle.truncate(contents.length);
  await handle.sync();
}

function lockOwnerPid(owner: string): number | undefined {
  try {
    const value: unknown = JSON.parse(owner);
    if (typeof value !== "object" || value === null) return undefined;
    const pid = Reflect.get(value, "pid");
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function lockOwnerReleased(owner: string): boolean {
  try {
    const value: unknown = JSON.parse(owner);
    return typeof value === "object" && value !== null && Reflect.get(value, "released") === true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  if (atomicFileTestHooks?.isProcessAlive !== undefined) {
    return atomicFileTestHooks.isProcessAlive(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
