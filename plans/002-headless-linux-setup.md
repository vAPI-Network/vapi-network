# 002 — Setup on Linux without a keyring (vapi-app plan 045, Part C)

Origin: vapi-app plan 045 (Earn support tickets 2026-11-08). A member could not run `vapi setup` in a GitHub Codespace: no libsecret keyring, so the device key and agent link cannot be stored. Builds on 0.12.1 (PR #38).

**Owner-approved change to the design below:** `chooseSecretBackend` probes the OS store only on Linux. Every other platform pins `os` at once with no probe and no keychain write, so macOS and Windows behave exactly as before.

Approved by Zep 2026-11-09 (D1 = yes, D2 env-only password, D3 min 12 chars). Tier deep (secrets storage).

### Design

- New `SecretStore` implementation, the **file store**: `~/.vapi/secrets.json`, mode `0600`, under `withVaultLock`. One random 32-byte scrypt salt per file; key = `deriveScryptKey(VAPI_VAULT_PASSWORD, salt)` (existing helper); each entry sealed with `encryptWithKey` (AES-256-GCM, fresh nonce). A `check` entry sealed at creation detects a wrong password before anything is read or written.
- It reads the password lazily from `VAPI_VAULT_PASSWORD` on each call, so every existing call site (`wallet-store`, `agent-link`, `api-key`, `passphrase`, MCP `server`/`wallet-session`, `runtime-railway`) works through the `SecretStore` interface unchanged.
- **Backend pin** `~/.vapi/secret-store.json` = `{"v":1,"backend":"os"|"file"}`, written once when a vault is created. `secretStore()` honours the pin. No pin = `os` = today's behaviour, so no existing install changes.
- **Choice at vault creation only** (`vapi setup` new/restore): if the OS store is `available` **and** a set/get/remove round trip of a throwaway entry succeeds → pin `os`. Else if `VAPI_VAULT_PASSWORD` is set and ≥ 12 chars → pin `file`. Else fail with one message naming both options. Choosing once and pinning prevents a vault being split across two stores when D-Bus is present in one shell and not another.
- Unchanged: TTY + agent-marker guard on setup, the phrase display gate, `vault protect` (still works; double password is harmless and not worth special-casing).

**File map**

- Create `packages/core/src/file-secret-store.ts` + `file-secret-store.test.ts` — the file store.
- Create `packages/core/src/secret-backend.ts` + `secret-backend.test.ts` — pin read/write and the creation-time choice.
- Modify `packages/core/src/secret-store.ts:102-112` — `secretStore()` honours the pin.
- Modify `packages/core/src/index.ts` — export both new modules.
- Modify `packages/core/src/vault-key.ts` — `HEADLESS_LINUX_HINT` names `VAPI_VAULT_PASSWORD`.
- Modify `packages/cli/src/setup.ts:~95` — choose the backend before the wallet store opens when no vault exists.
- Modify `packages/cli/src/setup.test.ts`.
- Modify `docs/wallets.md:36`, `docs/configuration.md`, `README.md` — headless section.
- Create `.github/workflows/` job `headless-linux` (or a step in the existing CI workflow) — real setup in a `node:22` container without libsecret.

### Task C1: the file store

**Interfaces:** Produces

```ts
export const FILE_SECRET_STORE_PASSWORD_ENV = "VAPI_VAULT_PASSWORD";
export const FILE_SECRET_STORE_MIN_PASSWORD = 12;
export function fileSecretStore(options: { path: string; env?: NodeJS.ProcessEnv }): SecretStore;
export async function createFileSecretStore(options: {
  path: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** — `packages/core/src/file-secret-store.test.ts`

```ts
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFileSecretStore, fileSecretStore } from "./file-secret-store.js";

const PASSWORD = "correct horse battery";

async function freshPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "vapi-file-store-")), "secrets.json");
}

describe("file secret store", () => {
  it("round-trips entries and never writes them in plain text", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    const store = fileSecretStore({ path, env });

    await store.set("vault-key", "c2VjcmV0LWRldmljZS1rZXk=");
    expect(await store.get("vault-key")).toBe("c2VjcmV0LWRldmljZS1rZXk=");
    expect(await store.has("vault-key")).toBe(true);
    expect(await readFile(path, "utf8")).not.toContain("c2VjcmV0LWRldmljZS1rZXk=");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.remove("vault-key")).toBe(true);
    expect(await store.remove("vault-key")).toBe(false);
    expect(await store.get("vault-key")).toBeUndefined();
  });

  it("refuses a wrong password before reading", async () => {
    const path = await freshPath();
    await createFileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: PASSWORD } });
    const store = fileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: "wrong password here" } });
    await expect(store.get("vault-key")).rejects.toThrow("Wrong VAPI_VAULT_PASSWORD");
  });

  it("refuses without a password and never falls back to plain text", async () => {
    const path = await freshPath();
    await createFileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: PASSWORD } });
    const store = fileSecretStore({ path, env: {} });
    expect(store.available).toBe(false);
    await expect(store.set("vault-key", "x")).rejects.toThrow("VAPI_VAULT_PASSWORD");
  });

  it("refuses to create with a short password", async () => {
    const path = await freshPath();
    await expect(
      createFileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: "short" } }),
    ).rejects.toThrow("at least 12 characters");
  });

  it("keeps both writers' entries when two run at once", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    await Promise.all([
      fileSecretStore({ path, env }).set("a", "1"),
      fileSecretStore({ path, env }).set("b", "2"),
    ]);
    const store = fileSecretStore({ path, env });
    expect([await store.get("a"), await store.get("b")]).toEqual(["1", "2"]);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @vapi-network/core exec vitest run src/file-secret-store.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `packages/core/src/file-secret-store.ts`

```ts
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { writeJsonAtomic } from "./atomic-file.js";
import { decryptWithKey, deriveScryptKey, encryptWithKey, KeystoreError } from "./keystore.js";
import type { SecretStore } from "./secret-store.js";
import { withVaultLock } from "./vault.js";

/**
 * A secret store in one encrypted file, for machines without a usable OS
 * keyring (servers, containers, GitHub Codespaces). Every entry is sealed with
 * AES-256-GCM under a key derived from VAPI_VAULT_PASSWORD; nothing is ever
 * written in plain text, and without the password every call refuses.
 */
export const FILE_SECRET_STORE_PASSWORD_ENV = "VAPI_VAULT_PASSWORD";
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
    entries: z.record(sealedSchema),
  })
  .strict();
type StoredFile = z.infer<typeof fileSchema>;
type Sealed = z.infer<typeof sealedSchema>;

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
  const salt = randomBytes(32);
  const key = await deriveScryptKey(password, salt);
  try {
    await withVaultLock(options.path, async () => {
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
    });
  } finally {
    key.fill(0);
  }
}

export function fileSecretStore(options: { path: string; env?: NodeJS.ProcessEnv }): SecretStore {
  const env = options.env ?? process.env;

  const withKey = async <T>(
    operation: (file: StoredFile, key: Buffer) => Promise<T>,
  ): Promise<T> => {
    const file = await readStoredFile(options.path);
    const key = await deriveScryptKey(passwordFrom(env), Buffer.from(file.salt, "base64"));
    try {
      if (open(key, file.check) !== CHECK_VALUE) throw wrongPassword();
      return await operation(file, key);
    } finally {
      key.fill(0);
    }
  };
  const write = async (change: (file: StoredFile, key: Buffer) => boolean): Promise<boolean> =>
    await withVaultLock(
      options.path,
      async () =>
        await withKey(async (file, key) => {
          const changed = change(file, key);
          if (changed) await writeJsonAtomic(options.path, file, { mode: 0o600 });
          return changed;
        }),
    );
  const get = async (name: string): Promise<string | undefined> =>
    await withKey(async (file, key) => {
      const sealed = file.entries[name];
      return sealed === undefined ? undefined : open(key, sealed);
    });

  return {
    available: Boolean(env[FILE_SECRET_STORE_PASSWORD_ENV]),
    platform: process.platform,
    description: "the encrypted vAPI secrets file",
    get,
    async has(name) {
      return (await get(name)) !== undefined;
    },
    async set(name, value) {
      await write((file, key) => {
        file.entries[name] = seal(key, value);
        return true;
      });
    },
    async remove(name) {
      return await write((file) => {
        if (file.entries[name] === undefined) return false;
        delete file.entries[name];
        return true;
      });
    },
  };
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
  const parsed = fileSchema.safeParse(JSON.parse(raw) as unknown);
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
```

Verified at plan time: `KeystoreError(message, options?: ErrorOptions)` (`keystore.ts:134`); `writeJsonAtomic(path, value, { mode })` defaults to `0o600` and creates the directory at `0o700` (`atomic-file.ts:42`).

- [ ] **Step 4: Run tests** — same command → PASS. Export from `packages/core/src/index.ts`: `export * from "./file-secret-store.js";`

- [ ] **Step 5: Commit** — `git add packages/core/src && git commit -s -m "feat(core): add an encrypted file secret store"`

### Task C2: backend pin and the creation-time choice

**Interfaces:** Produces (in `secret-backend.ts`)

```ts
export type SecretBackend = "os" | "file";
export function secretBackendPath(home?: string): string; // <home>/secret-store.json
export function secretsFilePath(home?: string): string; // <home>/secrets.json
export function readSecretBackend(home?: string): SecretBackend; // sync; "os" when no pin
export async function chooseSecretBackend(options: {
  home: string;
  os: SecretStore;
  env?: NodeJS.ProcessEnv;
}): Promise<SecretBackend>; // writes the pin
```

Consumes `fileSecretStore`, `createFileSecretStore` from C1. `home` defaults to `getVapiPaths().directory`.

- [ ] **Step 1: Write the failing tests** — `packages/core/src/secret-backend.test.ts`

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KeystoreError } from "./keystore.js";
import { chooseSecretBackend, readSecretBackend, secretBackendPath } from "./secret-backend.js";
import { memorySecretStore, type SecretStore } from "./secret-store.js";

const brokenOs: SecretStore = {
  ...memorySecretStore(),
  available: true,
  platform: "linux",
  set: async () => {
    throw new KeystoreError("Cannot autolaunch D-Bus without X11 $DISPLAY");
  },
};
const home = async () => await mkdtemp(join(tmpdir(), "vapi-backend-"));

describe("secret backend", () => {
  it("reads os when nothing is pinned", async () => {
    expect(readSecretBackend(await home())).toBe("os");
  });

  it("pins os when the OS store round-trips", async () => {
    const dir = await home();
    expect(await chooseSecretBackend({ home: dir, os: memorySecretStore(), env: {} })).toBe("os");
    expect(readSecretBackend(dir)).toBe("os");
  });

  it("pins file when the OS store fails and a password is set", async () => {
    const dir = await home();
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };
    expect(await chooseSecretBackend({ home: dir, os: brokenOs, env })).toBe("file");
    expect(JSON.parse(await readFile(secretBackendPath(dir), "utf8"))).toEqual({
      v: 1,
      backend: "file",
    });
  });

  it("explains both ways out when the OS store fails and no password is set", async () => {
    await expect(
      chooseSecretBackend({ home: await home(), os: brokenOs, env: {} }),
    ).rejects.toThrow(/VAPI_VAULT_PASSWORD[\s\S]*own computer/u);
  });

  it("leaves no throwaway entry in a working OS store", async () => {
    const os = memorySecretStore();
    await chooseSecretBackend({ home: await home(), os, env: {} });
    expect(await os.has("setup-probe")).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see them fail** — `pnpm --filter @vapi-network/core exec vitest run src/secret-backend.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement** — `packages/core/src/secret-backend.ts`

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-file.js";
import { getVapiPaths } from "./config.js";
import {
  createFileSecretStore,
  FILE_SECRET_STORE_MIN_PASSWORD,
  FILE_SECRET_STORE_PASSWORD_ENV,
} from "./file-secret-store.js";
import { KeystoreError } from "./keystore.js";
import type { SecretStore } from "./secret-store.js";

/**
 * Which store holds this vault's secrets, decided once when the vault is made.
 * Pinning stops a vault from being split across two stores when a keyring is
 * reachable from one shell and not another. No pin means the OS store, which
 * is every vault made before 0.13.0.
 */
export type SecretBackend = "os" | "file";

const PROBE_ACCOUNT = "setup-probe";

export function secretBackendPath(home = getVapiPaths().directory): string {
  return join(home, "secret-store.json");
}

export function secretsFilePath(home = getVapiPaths().directory): string {
  return join(home, "secrets.json");
}

export function readSecretBackend(home = getVapiPaths().directory): SecretBackend {
  try {
    const parsed = JSON.parse(readFileSync(secretBackendPath(home), "utf8")) as {
      backend?: unknown;
    };
    return parsed.backend === "file" ? "file" : "os";
  } catch {
    return "os";
  }
}

export async function chooseSecretBackend(options: {
  home: string;
  os: SecretStore;
  env?: NodeJS.ProcessEnv;
}): Promise<SecretBackend> {
  const env = options.env ?? process.env;
  let backend: SecretBackend;
  if (await osStoreWorks(options.os)) {
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
    await store.set(PROBE_ACCOUNT, "ok");
    const value = await store.get(PROBE_ACCOUNT);
    await store.remove(PROBE_ACCOUNT);
    return value === "ok";
  } catch {
    return false;
  }
}
```

Verified at plan time: `accountFor` (`secret-store.ts:501`) only trims and rejects empty names, so `setup-probe` is a valid account.

- [ ] **Step 4: `secretStore()` honours the pin** — in `secret-store.ts`, add a failing test first in `secret-store.test.ts`:

```ts
it("uses the file store when the vault is pinned to it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vapi-pin-"));
  writeFileSync(join(dir, "secret-store.json"), JSON.stringify({ v: 1, backend: "file" }));
  const store = secretStore({
    platform: "linux",
    home: dir,
    env: { VAPI_VAULT_PASSWORD: "x".repeat(12) },
  });
  expect(store.description).toBe("the encrypted vAPI secrets file");
});

it("keeps the OS store when nothing is pinned", () => {
  const store = secretStore({
    platform: "linux",
    home: "/nonexistent-vapi-home",
    installed: () => true,
  });
  expect(store.description).toBe("the libsecret keyring");
});
```

Then implement: add `home?: string` to `SecretStoreOptions` and at the top of `secretStore()`:

```ts
const home = options.home ?? getVapiPaths().directory;
if (readSecretBackend(home) === "file") {
  return fileSecretStore({ path: secretsFilePath(home), env: options.env ?? process.env });
}
```

If importing `secret-backend.ts` into `secret-store.ts` creates an import cycle (`secret-backend` → `file-secret-store` → type-only `secret-store`), it is type-only and safe; confirm `pnpm build` passes. Tests that call `secretStore({ platform })` without `home` now read the real `~/.vapi`; set `VAPI_HOME` to a temp dir in those suites' `beforeEach` if any start failing.

- [ ] **Step 5: Run** — `pnpm --filter @vapi-network/core test` → PASS. Export from `index.ts`: `export * from "./secret-backend.js";`. Commit: `git commit -s -m "feat(core): pin each vault to one secret store"`.

### Task C3: setup chooses the backend

**Interfaces:** Consumes `chooseSecretBackend`, `getVapiPaths`. In `setup.ts` the choice runs after the config is written and **before** `openWalletStore(dependencies)`, only when `vault.json` does not exist. Tests inject `dependencies.secretStore`; when it is set, skip the choice (tests own their store).

- [ ] **Step 1: Failing test** in `packages/cli/src/setup.test.ts`, following the file's existing harness (temp `VAPI_HOME`, injected `prompts`, TTY dependency). Add:

```ts
it("tells a headless Linux user how to continue when no keyring works", async () => {
  // Harness: no injected secretStore, platform store forced broken via the
  // existing secret-store runner injection used elsewhere in this file.
  const result = await runSetup({ env: {}, osStore: brokenLinuxStore() });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("VAPI_VAULT_PASSWORD");
  expect(result.stderr).toContain("own computer");
  expect(existsSync(join(result.home, "vault.json"))).toBe(false);
});

it("creates a file-backed vault when VAPI_VAULT_PASSWORD is set", async () => {
  const result = await runSetup({
    env: { VAPI_VAULT_PASSWORD: "correct horse battery" },
    osStore: brokenLinuxStore(),
    answers: ["new"],
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(result.home, "secret-store.json"), "utf8")).backend).toBe(
    "file",
  );
  expect(readFileSync(join(result.home, "secrets.json"), "utf8")).not.toMatch(
    /"vault-key":\s*"[A-Za-z0-9+/=]{40,}"/u,
  );
});

it("never re-chooses for an existing vault", async () => {
  const result = await runSetup({ existingVault: true, osStore: brokenLinuxStore(), env: {} });
  expect(existsSync(join(result.home, "secret-store.json"))).toBe(false);
});
```

`runSetup` / `brokenLinuxStore` are thin helpers the implementer writes at the top of the test file over the harness already used in `setup.test.ts` (read it first; reuse its `runCli` + temp-home pattern, do not invent a second harness). The link step needs the registry fetch stub the file already uses for login.

- [ ] **Step 2: Run, see them fail** — `pnpm --filter @vapi-network/cli exec vitest run src/setup.test.ts`.

- [ ] **Step 3: Implement** — in `setupCommand`, right after `const config = await readConfig(paths.config, humanIo);`:

```ts
if (
  dependencies.secretStore === undefined &&
  !(await fileExists(join(paths.directory, "vault.json")))
) {
  await chooseSecretBackend({
    home: paths.directory,
    os: secretStore({ home: paths.directory }),
    env: getEnvironment(dependencies),
  });
}
```

`secretStore({ home })` here returns the OS store because no pin exists yet. Import `chooseSecretBackend` and `secretStore` from `@vapi-network/core`, `getEnvironment` from `./cli.js`. Then in `vault-key.ts` change `HEADLESS_LINUX_HINT` to: `"A server, container or GitHub Codespace usually has no keyring. Set VAPI_VAULT_PASSWORD and run vapi setup again, or run vapi on your own computer."`; update the B2 test's `/connect` expectation to `VAPI_VAULT_PASSWORD`.

- [ ] **Step 4: Run** — `pnpm --filter @vapi-network/cli test && pnpm --filter @vapi-network/core test` → PASS. Commit: `git commit -s -m "feat(cli): set up a vault on Linux without a keyring"`.

### Task C4: real-container proof, docs, release 0.13.0

- [ ] **Step 1: CI job** — add a `headless-linux` job to the existing CI workflow: `runs-on: ubuntu-latest`, `container: node:22-bookworm` (no libsecret), steps: checkout, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm build`, then

```bash
export VAPI_HOME="$(mktemp -d)" VAPI_VAULT_PASSWORD='ci-only-password-1234'
# setup needs a TTY and refuses CI markers; give it a pty and unset CI for this one call
printf 'new\n\n' | env -u CI -u GITHUB_ACTIONS script -qec "node packages/vapi-network/dist/cli.js setup --no-cloud-backup" /dev/null || true
test "$(node -p 'require(process.env.VAPI_HOME + "/secret-store.json").backend')" = file
test -f "$VAPI_HOME/vault.json"
# the device key is stored sealed, never as a bare string
node -e 'const f=require(process.env.VAPI_HOME+"/secrets.json"); const e=f.entries["vault-key"]; if (!e || typeof e.ciphertext!=="string") process.exit(1)'
node packages/vapi-network/dist/cli.js accounts --json | grep -q '"address"'
```

Setup's link step needs the network and will fail in CI; that is why the setup line ends in `|| true` and the job asserts on the vault and the pin, then proves a second command opens the vault (`accounts`). The agent markers live in `packages/core/src/agent-guard.ts`; unset every one the guard reads that the runner sets (at least `CI` and `GITHUB_ACTIONS`). The bin is `packages/vapi-network/dist/cli.js` (`package.json` `bin.vapi`).

- [ ] **Step 2: Docs** — `docs/wallets.md:36` append: "On Linux without a working keyring (servers, containers, GitHub Codespaces), set `VAPI_VAULT_PASSWORD` before `vapi setup`; the device key and agent link are then kept in `~/.vapi/secrets.json`, encrypted with that password. The choice is made once per vault." Add the same as a short "Headless Linux" section in `README.md` and the variable's row in `docs/configuration.md` ("…and the encrypted secrets file on machines without a keyring").
- [ ] **Step 3: Release** — bump to `0.13.0` everywhere + `EXPECTED_VERSION`, changelog, run the full gate from B3 Step 2, commit `chore: release 0.13.0`, PR. Zep publishes.

**Part C done when:** the gate and the `headless-linux` job pass; a manual check in a fresh GitHub Codespace (Codespaces secret `VAPI_VAULT_PASSWORD` set) runs `npx -y vapi-network@0.13.0 setup` through to an approved device link, and the Earn "Connect an agent" quest completes for that account. A macOS run of `setup` on a clean `VAPI_HOME` still pins `os` (no behaviour change).

---
