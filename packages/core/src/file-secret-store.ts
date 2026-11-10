import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import { writeJsonAtomic } from "./atomic-file.js";
import { isMissingFile } from "./config.js";
import { decryptWithKey, deriveScryptKey, encryptWithKey, KeystoreError } from "./keystore.js";
import type { SecretStore } from "./secret-store.js";
import { withVaultLock } from "./vault.js";

/** The environment variable that unlocks the encrypted secrets file. */
export const FILE_SECRET_STORE_PASSWORD_ENV = "VAPI_VAULT_PASSWORD";
/** The minimum password length for a new encrypted secrets file. */
export const FILE_SECRET_STORE_MIN_PASSWORD = 12;

const CHECK_VALUE = "vapi-network file secret store";
const sealedSchema = z
  .object({ nonce: z.string(), ciphertext: z.string(), tag: z.string() })
  .strict();
const fileSchema = z
  .object({
    v: z.literal(1),
    salt: z.string(),
    check: sealedSchema,
    entries: z.record(z.string(), sealedSchema),
  })
  .strict();
type StoredFile = z.infer<typeof fileSchema>;
type Sealed = z.infer<typeof sealedSchema>;

/** Creates a secrets file, or validates an existing file without replacing its entries. */
export async function createFileSecretStore(options: {
  path: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const password = passwordFrom(options.env);
  if (password.length < FILE_SECRET_STORE_MIN_PASSWORD) {
    throw new KeystoreError(
      `${FILE_SECRET_STORE_PASSWORD_ENV} must be at least ${FILE_SECRET_STORE_MIN_PASSWORD} characters.`,
    );
  }
  await withVaultLock(options.path, async () => {
    let exists = true;
    try {
      await stat(options.path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      exists = false;
    }
    if (exists) {
      await withKey(options.path, options.env, async () => undefined);
      return;
    }

    const salt = randomBytes(32);
    const key = await deriveScryptKey(password, salt);
    try {
      await writeJsonAtomic(
        options.path,
        {
          v: 1,
          salt: salt.toString("base64"),
          check: seal(key, CHECK_VALUE),
          entries: {},
        } satisfies StoredFile,
        { mode: 0o600 },
      );
    } finally {
      key.fill(0);
    }
  });
}

/** A file secret store that reads VAPI_VAULT_PASSWORD afresh on every call. */
export function fileSecretStore(options: { path: string; env?: NodeJS.ProcessEnv }): SecretStore {
  const env = options.env ?? process.env;

  const write = async (change: (file: StoredFile, key: Buffer) => boolean): Promise<boolean> =>
    await withVaultLock(
      options.path,
      async () =>
        await withKey(options.path, env, async (file, key) => {
          const changed = change(file, key);
          if (changed) await writeJsonAtomic(options.path, file, { mode: 0o600 });
          return changed;
        }),
    );
  const get = async (name: string): Promise<string | undefined> =>
    await withKey(options.path, env, async (file, key) => {
      const sealed = Object.hasOwn(file.entries, name) ? file.entries[name] : undefined;
      return sealed === undefined ? undefined : open(key, sealed);
    });

  return {
    // A locked backend still exists; it must never enable a plaintext fallback.
    available: true,
    platform: process.platform,
    description: "the encrypted vAPI secrets file",
    get,
    async has(name) {
      return (await get(name)) !== undefined;
    },
    async set(name, value) {
      if (name === "__proto__") {
        throw new KeystoreError("The secret name is reserved in the encrypted vAPI secrets file.");
      }
      await write((file, key) => {
        file.entries[name] = seal(key, value);
        return true;
      });
    },
    async remove(name) {
      return await write((file) => {
        if (!Object.hasOwn(file.entries, name)) return false;
        delete file.entries[name];
        return true;
      });
    },
  };
}

async function withKey<T>(
  path: string,
  env: NodeJS.ProcessEnv | undefined,
  operation: (file: StoredFile, key: Buffer) => Promise<T>,
): Promise<T> {
  const file = await readStoredFile(path);
  const key = await deriveScryptKey(passwordFrom(env), Buffer.from(file.salt, "base64"));
  try {
    if (open(key, file.check) !== CHECK_VALUE) throw wrongPassword();
    return await operation(file, key);
  } finally {
    key.fill(0);
  }
}

function passwordFrom(env: NodeJS.ProcessEnv | undefined): string {
  const password = (env ?? process.env)[FILE_SECRET_STORE_PASSWORD_ENV];
  if (!password) {
    throw new KeystoreError(
      `This vault keeps its secrets in an encrypted file. Set ${FILE_SECRET_STORE_PASSWORD_ENV} to open it.`,
    );
  }
  return password;
}

async function readStoredFile(path: string): Promise<StoredFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new KeystoreError("The vAPI secrets file is missing. Run vapi setup again.", {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new KeystoreError("The vAPI secrets file is damaged.");
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw new KeystoreError("The vAPI secrets file is damaged.");
  return parsed.data;
}

function seal(key: Buffer, value: string): Sealed {
  const { nonce, ciphertext, tag } = encryptWithKey(key, Buffer.from(value, "utf8"));
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function open(key: Buffer, sealed: Sealed): string {
  try {
    return decryptWithKey(key, {
      nonce: Buffer.from(sealed.nonce, "base64"),
      ciphertext: Buffer.from(sealed.ciphertext, "base64"),
      tag: Buffer.from(sealed.tag, "base64"),
    }).toString("utf8");
  } catch (error) {
    throw wrongPassword(error);
  }
}

function wrongPassword(cause?: unknown): KeystoreError {
  return new KeystoreError(`Wrong ${FILE_SECRET_STORE_PASSWORD_ENV} for the vAPI secrets file.`, {
    cause,
  });
}
