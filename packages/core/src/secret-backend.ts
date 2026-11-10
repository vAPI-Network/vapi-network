import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeJsonAtomic } from "./atomic-file.js";
import { getVapiPaths, isMissingFile } from "./config.js";
import {
  createFileSecretStore,
  FILE_SECRET_STORE_MIN_PASSWORD,
  FILE_SECRET_STORE_PASSWORD_ENV,
} from "./file-secret-store.js";
import { KeystoreError } from "./keystore.js";
import type { SecretStore } from "./secret-store.js";

/** The store chosen when a vault is created; a missing pin means the OS store. */
export type SecretBackend = "os" | "file";

const PROBE_ACCOUNT = "setup-probe";
const pinSchema = z.object({ v: z.literal(1), backend: z.enum(["os", "file"]) }).strict();

/** The pin that keeps a vault's secrets in one backend. */
export function secretBackendPath(home = getVapiPaths().directory): string {
  return join(home, "secret-store.json");
}

/** The encrypted file used on machines without a working keyring. */
export function secretsFilePath(home = getVapiPaths().directory): string {
  return join(home, "secrets.json");
}

/** Reads the vault's backend pin, defaulting to the OS store when absent. */
export function readSecretBackend(home = getVapiPaths().directory): SecretBackend {
  const path = secretBackendPath(home);
  try {
    const parsed = pinSchema.safeParse(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (parsed.success) return parsed.data.backend;
  } catch (error) {
    if (isMissingFile(error)) return "os";
  }
  throw new KeystoreError(`The vAPI secret-store pin at ${path} is damaged.`);
}

/** Chooses and pins a new vault's backend, probing the OS store only on Linux. */
export async function chooseSecretBackend(options: {
  home: string;
  os: SecretStore;
  env?: NodeJS.ProcessEnv;
}): Promise<SecretBackend> {
  const env = options.env ?? process.env;
  let backend: SecretBackend;
  if (options.os.platform !== "linux" || (await osStoreWorks(options.os))) {
    backend = "os";
  } else if (env[FILE_SECRET_STORE_PASSWORD_ENV]) {
    await createFileSecretStore({ path: secretsFilePath(options.home), env });
    backend = "file";
  } else {
    throw new KeystoreError(
      [
        `This machine has no working keyring (${options.os.description}).`,
        `Set ${FILE_SECRET_STORE_PASSWORD_ENV} (at least ${FILE_SECRET_STORE_MIN_PASSWORD} characters; in a GitHub Codespace add it as a Codespaces secret) and run vapi setup again,`,
        "or run vapi on your own computer, or connect Claude from https://api.vapinetwork.ai/connect.",
      ].join(" "),
    );
  }
  await writeJsonAtomic(secretBackendPath(options.home), { v: 1, backend }, { mode: 0o600 });
  return backend;
}

async function osStoreWorks(store: SecretStore): Promise<boolean> {
  if (!store.available) return false;
  try {
    try {
      await store.set(PROBE_ACCOUNT, "ok");
      return (await store.get(PROBE_ACCOUNT)) === "ok";
    } finally {
      await store.remove(PROBE_ACCOUNT);
    }
  } catch {
    return false;
  }
}
