import { execFile } from "node:child_process";

import { KeystoreError } from "./keystore.js";

/**
 * The OS secret store, so an agent never needs a passphrase in plain text.
 *
 * A wallet's passphrase is kept by the operating system's own credential
 * store — the macOS Keychain, or libsecret on Linux — under the service
 * `vapi-network` and the wallet's name as the account. `vapi unlock` puts it
 * there, `vapi lock` takes it out, and every unlock path reads it from there
 * before falling back to a prompt.
 *
 * There is no dependency: the store is driven through the OS binaries with
 * `execFile` and an argument array, never a shell string, so nothing a wallet
 * name or a passphrase contains can be read as a command. The passphrase
 * itself is written to the binary's stdin and never appears in an argument,
 * where `ps` would show it to every process on the machine.
 */

/** The service name every vAPI entry is filed under. */
export const SECRET_STORE_SERVICE = "vapi-network";

/** The macOS binary, by absolute path: a credential store is not worth a PATH lookup. */
const SECURITY_BINARY = "/usr/bin/security";
const SECRET_TOOL_BINARY = "secret-tool";

/** `security` says 44 when the keychain holds no such item. */
const SECURITY_ITEM_NOT_FOUND = 44;

const UNSUPPORTED_PLATFORM = "No OS secret store on this platform yet; use VAPI_KEYSTORE_PASSWORD.";

const SECRET_TOOL_MISSING = [
  "secret-tool is not installed, so the passphrase cannot be kept in the OS secret store.",
  "Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch), or use VAPI_KEYSTORE_PASSWORD.",
].join(" ");

/** What one run of an OS binary produced. A runner never throws for a non-zero exit. */
export type SecretStoreOutcome = {
  /** The exit code, or null when the binary could not be run at all. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The binary is not installed on this machine. */
  notFound?: boolean;
};

/**
 * Runs one OS binary. Injected by the tests, which assert the command line
 * rather than touching a real keychain.
 */
export type SecretStoreRunner = (
  file: string,
  args: readonly string[],
  input?: string,
) => Promise<SecretStoreOutcome>;

export type SecretStore = {
  /** Whether this platform has a store vAPI can drive at all. */
  available: boolean;
  platform: NodeJS.Platform;
  /** How to name this store to a person, such as "the macOS Keychain". */
  description: string;
  /** The stored passphrase of a wallet, or undefined when there is none. */
  get(name: string): Promise<string | undefined>;
  /** Whether a wallet has a stored passphrase, without reading the secret. */
  has(name: string): Promise<boolean>;
  set(name: string, passphrase: string): Promise<void>;
  /** Removes the entry; false when there was nothing to remove. */
  remove(name: string): Promise<boolean>;
  /**
   * The wallet names this store holds, where the platform can answer it
   * without handing back the secrets themselves. Neither platform can today,
   * so callers list the wallets they know and ask `has` about each.
   */
  list?(): Promise<string[]>;
};

export type SecretStoreOptions = {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Defaults to running the real binary. */
  run?: SecretStoreRunner | undefined;
};

/** The secret store of this machine, or one that refuses on every call. */
export function secretStore(options: SecretStoreOptions = {}): SecretStore {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? spawnRunner;
  if (platform === "darwin") return keychainStore(platform, run);
  if (platform === "linux") return libsecretStore(platform, run);
  return unsupportedStore(platform);
}

/**
 * macOS. The passphrase goes in over stdin: `security add-generic-password`
 * with a bare `-w` asks for the password and its confirmation on stdin, which
 * keeps it out of the argument list that `ps` publishes. `-U` updates the
 * entry when the wallet already has one.
 */
function keychainStore(platform: NodeJS.Platform, run: SecretStoreRunner): SecretStore {
  const find = async (name: string, withPassword: boolean): Promise<SecretStoreOutcome> =>
    await run(SECURITY_BINARY, [
      "find-generic-password",
      "-a",
      accountFor(name),
      "-s",
      SECRET_STORE_SERVICE,
      ...(withPassword ? ["-w"] : []),
    ]);

  return {
    available: true,
    platform,
    description: "the macOS Keychain",
    async get(name) {
      const result = await find(name, true);
      if (result.code === SECURITY_ITEM_NOT_FOUND) return undefined;
      requireSuccess(result, `read the passphrase of ${name} from the macOS Keychain`);
      const value = withoutTrailingNewline(result.stdout);
      return value.length === 0 ? undefined : value;
    },
    async has(name) {
      const result = await find(name, false);
      if (result.code === SECURITY_ITEM_NOT_FOUND) return false;
      requireSuccess(result, `look up ${name} in the macOS Keychain`);
      return true;
    },
    async set(name, passphrase) {
      requirePassphrase(passphrase);
      const account = accountFor(name);
      const result = await run(
        SECURITY_BINARY,
        [
          "add-generic-password",
          "-a",
          account,
          "-s",
          SECRET_STORE_SERVICE,
          "-l",
          `${SECRET_STORE_SERVICE} ${account}`,
          "-U",
          "-w",
        ],
        // `security` asks for the password and then for its confirmation.
        `${passphrase}\n${passphrase}\n`,
      );
      requireSuccess(result, `store the passphrase of ${name} in the macOS Keychain`);
    },
    async remove(name) {
      const result = await run(SECURITY_BINARY, [
        "delete-generic-password",
        "-a",
        accountFor(name),
        "-s",
        SECRET_STORE_SERVICE,
      ]);
      if (result.code === SECURITY_ITEM_NOT_FOUND) return false;
      requireSuccess(result, `remove the passphrase of ${name} from the macOS Keychain`);
      return true;
    },
  };
}

/**
 * Linux, through libsecret's `secret-tool`. `store` reads the passphrase from
 * stdin; `lookup` prints it and exits non-zero when there is nothing to find.
 */
function libsecretStore(platform: NodeJS.Platform, run: SecretStoreRunner): SecretStore {
  const lookup = async (name: string): Promise<string | undefined> => {
    const result = await run(SECRET_TOOL_BINARY, [
      "lookup",
      "service",
      SECRET_STORE_SERVICE,
      "account",
      accountFor(name),
    ]);
    requireBinary(result);
    const value = withoutTrailingNewline(result.stdout);
    if (result.code === 0) return value.length === 0 ? undefined : value;
    // secret-tool exits 1 with nothing to say when the item is absent; only a
    // message on stderr means something actually went wrong.
    if (result.stderr.trim().length === 0) return undefined;
    requireSuccess(result, `read the passphrase of ${name} from the secret service`);
    return undefined;
  };

  return {
    available: true,
    platform,
    description: "the libsecret keyring",
    get: lookup,
    async has(name) {
      return (await lookup(name)) !== undefined;
    },
    async set(name, passphrase) {
      requirePassphrase(passphrase);
      const account = accountFor(name);
      const result = await run(
        SECRET_TOOL_BINARY,
        [
          "store",
          `--label=${SECRET_STORE_SERVICE} ${account}`,
          "service",
          SECRET_STORE_SERVICE,
          "account",
          account,
        ],
        `${passphrase}\n`,
      );
      requireBinary(result);
      requireSuccess(result, `store the passphrase of ${name} in the secret service`);
    },
    async remove(name) {
      // `secret-tool clear` succeeds whether or not it matched anything, so the
      // lookup is what tells a person their passphrase was really there.
      const existed = (await lookup(name)) !== undefined;
      const result = await run(SECRET_TOOL_BINARY, [
        "clear",
        "service",
        SECRET_STORE_SERVICE,
        "account",
        accountFor(name),
      ]);
      requireBinary(result);
      requireSuccess(result, `remove the passphrase of ${name} from the secret service`);
      return existed;
    },
  };
}

/** Windows and everything else: the environment variable stays the only route. */
function unsupportedStore(platform: NodeJS.Platform): SecretStore {
  const refuse = (): never => {
    throw new KeystoreError(UNSUPPORTED_PLATFORM);
  };
  return {
    available: false,
    platform,
    description: "no OS secret store",
    get: async () => refuse(),
    has: async () => refuse(),
    set: async () => refuse(),
    remove: async () => refuse(),
  };
}

/** The account a wallet is filed under. Wallet names are already path-safe. */
function accountFor(name: string): string {
  const account = name.trim();
  if (account.length === 0) {
    throw new KeystoreError("A wallet name is needed to reach the OS secret store.");
  }
  return account;
}

function requirePassphrase(passphrase: string): void {
  if (passphrase.length === 0) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }
}

function requireBinary(result: SecretStoreOutcome): void {
  if (result.notFound === true) throw new KeystoreError(SECRET_TOOL_MISSING);
}

/** Turns a failed run into one sentence. The passphrase is never in it. */
function requireSuccess(result: SecretStoreOutcome, what: string): void {
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new KeystoreError(
    `Could not ${what}${result.code === null ? "" : ` (exit ${result.code})`}.${
      detail.length === 0 ? "" : ` ${detail}`
    }`,
  );
}

function withoutTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

/** Runs the binary with an argument array; the passphrase goes in over stdin. */
const spawnRunner: SecretStoreRunner = async (file, args, input) =>
  await new Promise<SecretStoreOutcome>((resolve) => {
    const child = execFile(
      file,
      [...args],
      { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resolve({ code: null, stdout, stderr, notFound: true });
          return;
        }
        resolve({ code: typeof code === "number" ? code : null, stdout, stderr });
      },
    );
    // The callback above reports a failed spawn; this keeps it from throwing.
    child.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
