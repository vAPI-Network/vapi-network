import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";

import { z } from "zod";

import {
  DEFAULT_SPEND_CAPS,
  getVapiPaths,
  isMissingFile,
  spendCapsSchema,
  type SpendCaps,
} from "./config.js";
import {
  createKeystoreFromPrivateKey,
  createKeystoreWithPhrase,
  KeystoreError,
  unlockKeystore,
  type VapiPaymentAccount,
} from "./keystore.js";
import { renameReceiptWallet } from "./receipts.js";
import {
  DEFAULT_WALLET_NAME,
  isWalletName,
  walletNameSchema,
  type WalletName,
} from "./wallet-name.js";

export {
  DEFAULT_WALLET_NAME,
  isWalletName,
  walletNameSchema,
  WALLET_NAME_PATTERN,
  type WalletName,
} from "./wallet-name.js";

/** What `wallets.json` records about one wallet. The keys live in its keystore. */
export const walletEntrySchema = z.object({
  createdAt: z.iso.datetime(),
  label: z.string().trim().min(1).max(80).optional(),
  spendCaps: spendCapsSchema,
});

export const walletRegistrySchema = z.object({
  version: z.literal(1),
  default: walletNameSchema.optional(),
  wallets: z.record(walletNameSchema, walletEntrySchema),
});

export type WalletEntry = z.infer<typeof walletEntrySchema>;
export type WalletRegistry = z.infer<typeof walletRegistrySchema>;

/** How a caller names the wallet it wants; every field is optional. */
export type WalletSelection = {
  /** An explicit name, from `--wallet` or an MCP argument. */
  name?: string | undefined;
  /** Environment to read `VAPI_WALLET` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
};

export type ResolvedWallet = {
  name: WalletName;
  path: string;
  entry: WalletEntry;
};

export type WalletInfo = ResolvedWallet & {
  address?: string;
  solanaAddress?: string;
  keystoreVersion?: number;
  isDefault: boolean;
  spendCaps: SpendCaps;
  label?: string;
  createdAt: string;
};

export type CreatedWallet = ResolvedWallet & {
  account: VapiPaymentAccount;
  recoveryPhrase: string;
};

export type ImportedWallet = ResolvedWallet & {
  account: VapiPaymentAccount;
};

export type TrashedWallet = {
  name: WalletName;
  removedAt: string;
  path: string;
  entry?: WalletEntry;
};

/** Reads the USDC balance of an address, so `remove` can refuse a funded wallet. */
export type WalletBalanceReader = (address: string) => Promise<bigint>;

export type WalletStoreOptions = {
  /** Injected clock, so `createdAt` is deterministic in tests. */
  now?: () => Date;
};

export type LayoutMigration = {
  moved: boolean;
  from?: string;
  to?: string;
};

const WALLETS_DIRECTORY = "wallets";
const TRASH_DIRECTORY = ".trash";
const REGISTRY_FILE = "wallets.json";
const TRASHED_NAME_PATTERN = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.json$/;

/**
 * The wallets on this machine: one registry file, one keystore per wallet, and
 * the rules for picking the wallet a command acts on. Keys never leave the
 * keystore files; the store only moves, names and caps them.
 *
 * Layout under the config home (`~/.vapi`, or `VAPI_HOME`):
 *
 * ```
 * wallets.json          registry: default wallet, per-wallet caps and labels
 * wallets/<name>.json   one keystore per wallet, mode 0600
 * wallets/.trash/       removed wallets, kept encrypted, never auto-deleted
 * keystore.json         symlink to wallets/main.json after the 0.2.x migration
 * ```
 */
export class WalletStore {
  private registry: WalletRegistry;

  private constructor(
    /** The config home these wallets live under. */
    readonly home: string,
    private readonly options: WalletStoreOptions,
    registry: WalletRegistry,
  ) {
    this.registry = registry;
  }

  /** Opens the store, migrating a 0.2.x single-keystore home on the way. */
  static async open(
    home = getVapiPaths().directory,
    options: WalletStoreOptions = {},
  ): Promise<WalletStore> {
    const store = new WalletStore(home, options, emptyRegistry());
    await store.migrateLegacyLayout();
    await store.reload();
    return store;
  }

  get registryPath(): string {
    return join(this.home, REGISTRY_FILE);
  }

  get walletsDirectory(): string {
    return join(this.home, WALLETS_DIRECTORY);
  }

  get trashDirectory(): string {
    return join(this.walletsDirectory, TRASH_DIRECTORY);
  }

  /** The keystore path of a wallet, whether or not it exists yet. */
  pathFor(name: string): string {
    return join(this.walletsDirectory, `${assertWalletName(name)}.json`);
  }

  /** The names this machine knows, in registry order. */
  names(): WalletName[] {
    return Object.keys(this.registry.wallets);
  }

  /** The name a command uses when nothing selects another wallet. */
  get defaultName(): WalletName | undefined {
    return this.registry.default;
  }

  /** True once `wallets.json` exists; false for an un-migrated 0.2.x home. */
  hasRegistry(): boolean {
    return this.registry.default !== undefined || this.names().length > 0;
  }

  entry(name: string): WalletEntry | undefined {
    return isWalletName(name) ? this.registry.wallets[name] : undefined;
  }

  has(name: string): boolean {
    return this.entry(name) !== undefined;
  }

  /** A copy of the registry as it was last read or written. */
  snapshot(): WalletRegistry {
    return structuredClone(this.registry);
  }

  /** Re-reads `wallets.json` from disk. */
  async reload(): Promise<WalletRegistry> {
    this.registry = await this.readRegistry();
    return this.snapshot();
  }

  /**
   * Picks the wallet a command acts on: an explicit name first, then
   * `VAPI_WALLET`, then the registry default.
   */
  resolve(selection: WalletSelection = {}): ResolvedWallet {
    const environment = selection.env ?? process.env;
    const requested = selection.name?.trim() || environment.VAPI_WALLET?.trim() || undefined;
    const name = requested ?? this.registry.default;
    if (name === undefined) {
      throw new KeystoreError("No wallet yet. Run vapi init.");
    }
    assertWalletName(name);
    const entry = this.registry.wallets[name];
    if (!entry) {
      throw new KeystoreError(unknownWalletMessage(name, this.names()));
    }
    return { name, path: this.pathFor(name), entry: structuredClone(entry) };
  }

  /** Every wallet with its addresses, read without a passphrase. */
  async list(): Promise<WalletInfo[]> {
    const infos: WalletInfo[] = [];
    for (const [name, entry] of Object.entries(this.registry.wallets)) {
      const path = this.pathFor(name);
      const summary = await readKeystoreSummary(path);
      infos.push({
        name,
        path,
        entry: structuredClone(entry),
        isDefault: name === this.registry.default,
        spendCaps: { ...entry.spendCaps },
        createdAt: entry.createdAt,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(summary.address === undefined ? {} : { address: summary.address }),
        ...(summary.solanaAddress === undefined ? {} : { solanaAddress: summary.solanaAddress }),
        ...(summary.version === undefined ? {} : { keystoreVersion: summary.version }),
      });
    }
    return infos;
  }

  /** The stored Base address of a wallet, without its passphrase. */
  async readAddress(name: string): Promise<string | undefined> {
    return (await readKeystoreSummary(this.pathFor(name))).address;
  }

  /**
   * Creates a wallet from a fresh or supplied recovery phrase. The first wallet
   * on a machine also becomes the default. The phrase is returned once and is
   * never written anywhere but the encrypted keystore.
   */
  async create(
    name: string,
    passphrase: string,
    options: {
      phrase?: string;
      enableSolana?: boolean;
      label?: string;
      spendCaps?: SpendCaps;
    } = {},
  ): Promise<CreatedWallet> {
    const path = await this.prepareNewWallet(name);
    const created = await createKeystoreWithPhrase(passphrase, path, {
      ...(options.phrase === undefined ? {} : { phrase: options.phrase }),
      ...(options.enableSolana === undefined ? {} : { enableSolana: options.enableSolana }),
    });
    const entry = await this.registerWallet(name, options);
    return { name, path, entry, account: created.account, recoveryPhrase: created.recoveryPhrase };
  }

  /** Wraps a private key the user already holds in a new named wallet. */
  async importKey(
    name: string,
    passphrase: string,
    privateKey: string,
    options: { label?: string; spendCaps?: SpendCaps } = {},
  ): Promise<ImportedWallet> {
    const path = await this.prepareNewWallet(name);
    const account = await createKeystoreFromPrivateKey(passphrase, path, { privateKey });
    const entry = await this.registerWallet(name, options);
    return { name, path, entry, account };
  }

  /** Opens one wallet's keystore with its passphrase. */
  async unlock(name: string, passphrase: string): Promise<VapiPaymentAccount> {
    const wallet = this.resolve({ name });
    return await unlockKeystore(passphrase, wallet.path);
  }

  async setDefault(name: string): Promise<WalletRegistry> {
    const wallet = this.resolve({ name });
    return await this.update((registry) => {
      registry.default = wallet.name;
    });
  }

  async setSpendCaps(name: string, caps: SpendCaps): Promise<WalletEntry> {
    const parsed = spendCapsSchema.parse(caps);
    const wallet = this.resolve({ name });
    await this.update((registry) => {
      const entry = registry.wallets[wallet.name];
      if (entry) entry.spendCaps = parsed;
    });
    return { ...wallet.entry, spendCaps: parsed };
  }

  /** Sets or, with `undefined`, clears the human label of a wallet. */
  async setLabel(name: string, label: string | undefined): Promise<WalletEntry> {
    const parsed =
      label === undefined || label.trim().length === 0
        ? undefined
        : walletEntrySchema.shape.label.parse(label);
    const wallet = this.resolve({ name });
    await this.update((registry) => {
      const entry = registry.wallets[wallet.name];
      if (!entry) return;
      if (parsed === undefined) delete entry.label;
      else entry.label = parsed;
    });
    const entry = { ...wallet.entry };
    if (parsed === undefined) delete entry.label;
    else entry.label = parsed;
    return entry;
  }

  /**
   * Renames a wallet everywhere its name is recorded: the keystore file, the
   * registry, and the wallet field of its receipts. The keystore contents are
   * moved untouched.
   */
  async rename(oldName: string, newName: string): Promise<ResolvedWallet> {
    const wallet = this.resolve({ name: oldName });
    const target = assertWalletName(newName);
    if (target === wallet.name) return wallet;
    if (this.has(target)) {
      throw new KeystoreError(`Wallet ${target} already exists. Choose another name.`);
    }
    const targetPath = this.pathFor(target);
    if (await pathExists(targetPath)) {
      throw new KeystoreError(
        `A keystore already exists at ${targetPath}. Refusing to overwrite it.`,
      );
    }
    await rename(wallet.path, targetPath);
    await this.retargetLegacyKeystoreLink(wallet.path, targetPath);
    await this.update((registry) => {
      const entry = registry.wallets[wallet.name];
      delete registry.wallets[wallet.name];
      if (entry) registry.wallets[target] = entry;
      if (registry.default === wallet.name) registry.default = target;
    });
    await renameReceiptWallet(wallet.name, target, getVapiPaths(this.home).receipts);
    return { name: target, path: targetPath, entry: wallet.entry };
  }

  /**
   * Moves a wallet's keystore to `wallets/.trash/`. Nothing is deleted: the
   * encrypted file stays, and its passphrase still opens it. The default wallet
   * and a wallet that still holds USDC are refused unless forced.
   *
   * `allowDefault` exists for one caller: `vapi import --replace`, which puts a
   * new wallet under the same name back in place immediately afterwards, so the
   * machine is never left without a default. `vapi wallet remove` never sets it.
   */
  async remove(
    name: string,
    options: {
      force?: boolean;
      balanceReader?: WalletBalanceReader;
      allowDefault?: boolean;
    } = {},
  ): Promise<TrashedWallet> {
    const wallet = this.resolve({ name });
    if (options.allowDefault !== true && wallet.name === this.registry.default) {
      throw new KeystoreError(
        `Wallet ${wallet.name} is the default wallet. Choose another default first with vapi wallet use <name>.`,
      );
    }
    if (options.force !== true && options.balanceReader) {
      const address = await this.readAddress(wallet.name);
      if (address) {
        const balance = await options.balanceReader(address);
        if (balance > 0n) {
          throw new KeystoreError(
            `Wallet ${wallet.name} (${address}) still holds ${balance} atomic USDC. Move the funds out with vapi sweep first, or re-run with --force.`,
          );
        }
      }
    }

    const removedAt = this.now().toISOString();
    await mkdir(this.trashDirectory, { recursive: true, mode: 0o700 });
    const trashedPath = join(this.trashDirectory, `${wallet.name}-${removedAt}.json`);
    await rename(wallet.path, trashedPath);
    await chmod(trashedPath, 0o600);
    await writeJsonFile(entrySidecarPath(trashedPath), wallet.entry);
    await this.retargetLegacyKeystoreLink(wallet.path);
    await this.update((registry) => {
      delete registry.wallets[wallet.name];
    });
    return { name: wallet.name, removedAt, path: trashedPath, entry: wallet.entry };
  }

  /** Brings the most recently removed wallet of that name back. */
  async restore(name: string): Promise<ResolvedWallet> {
    const target = assertWalletName(name);
    if (this.has(target)) {
      throw new KeystoreError(`Wallet ${target} already exists. Rename it before restoring.`);
    }
    const trashed = (await this.listTrash()).find((candidate) => candidate.name === target);
    if (!trashed) {
      throw new KeystoreError(`No removed wallet named ${target} is in ${this.trashDirectory}.`);
    }
    const path = this.pathFor(target);
    if (await pathExists(path)) {
      throw new KeystoreError(`A keystore already exists at ${path}. Refusing to overwrite it.`);
    }
    await mkdir(this.walletsDirectory, { recursive: true, mode: 0o700 });
    await rename(trashed.path, path);
    await chmod(path, 0o600);
    await unlink(entrySidecarPath(trashed.path)).catch(() => undefined);
    const entry = trashed.entry ?? this.newEntry({});
    await this.update((registry) => {
      registry.wallets[target] = entry;
      registry.default ??= target;
    });
    return { name: target, path, entry };
  }

  /** Every removed wallet still in the trash, newest first. */
  async listTrash(): Promise<TrashedWallet[]> {
    let files: string[];
    try {
      files = await readdir(this.trashDirectory);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const trashed: TrashedWallet[] = [];
    for (const file of files.sort()) {
      const match = TRASHED_NAME_PATTERN.exec(file);
      if (!match) continue;
      const [, name, removedAt] = match;
      if (name === undefined || removedAt === undefined || !isWalletName(name)) continue;
      const path = join(this.trashDirectory, file);
      const entry = await readEntrySidecar(entrySidecarPath(path));
      trashed.push({ name, removedAt, path, ...(entry ? { entry } : {}) });
    }
    return trashed.reverse();
  }

  /**
   * Moves a 0.2.x home into the wallet layout, once: `keystore.json` becomes
   * `wallets/main.json` and `keystore.json` stays behind as a symlink for one
   * release, so scripts and 0.2.x callers keep working. The keystore contents
   * are never rewritten, and a home without a keystore migrates nothing.
   */
  async migrateLegacyLayout(): Promise<LayoutMigration> {
    const legacyPath = getVapiPaths(this.home).keystore;
    let info;
    try {
      info = await lstat(legacyPath);
    } catch (error) {
      if (isMissingFile(error)) return { moved: false };
      throw error;
    }
    // A symlink means the migration already ran; anything but a regular file
    // is not ours to move.
    if (!info.isFile()) return { moved: false };

    const target = this.pathFor(DEFAULT_WALLET_NAME);
    if (await pathExists(target)) return { moved: false };

    await mkdir(this.walletsDirectory, { recursive: true, mode: 0o700 });
    await rename(legacyPath, target);
    await chmod(target, 0o600);
    try {
      await symlink(join(WALLETS_DIRECTORY, `${DEFAULT_WALLET_NAME}.json`), legacyPath);
    } catch {
      // A filesystem without symlinks keeps the moved wallet; only the 0.2.x
      // compatibility path is lost.
    }

    const registry = await this.readRegistry();
    registry.wallets[DEFAULT_WALLET_NAME] ??= {
      createdAt: keystoreCreatedAt(info),
      spendCaps: await readConfiguredSpendCaps(getVapiPaths(this.home).config),
    };
    registry.default ??= DEFAULT_WALLET_NAME;
    await this.writeRegistry(registry);
    return { moved: true, from: legacyPath, to: target };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private newEntry(options: { label?: string; spendCaps?: SpendCaps }): WalletEntry {
    return walletEntrySchema.parse({
      createdAt: this.now().toISOString(),
      spendCaps: options.spendCaps ?? { ...DEFAULT_SPEND_CAPS },
      ...(options.label === undefined || options.label.trim().length === 0
        ? {}
        : { label: options.label }),
    });
  }

  private async prepareNewWallet(name: string): Promise<string> {
    const target = assertWalletName(name);
    if (this.has(target)) {
      throw new KeystoreError(`Wallet ${target} already exists. Choose another name.`);
    }
    const path = this.pathFor(target);
    if (await pathExists(path)) {
      throw new KeystoreError(
        `A keystore already exists at ${path}. Refusing to replace the local payment key.`,
      );
    }
    await mkdir(this.walletsDirectory, { recursive: true, mode: 0o700 });
    return path;
  }

  private async registerWallet(
    name: string,
    options: { label?: string; spendCaps?: SpendCaps },
  ): Promise<WalletEntry> {
    const entry = this.newEntry(options);
    await this.update((registry) => {
      registry.wallets[name] = entry;
      registry.default ??= name;
    });
    return entry;
  }

  /**
   * Keeps the compatibility symlink honest: when the wallet it points at moves,
   * the link follows it, and when that wallet is removed, the link goes too.
   */
  private async retargetLegacyKeystoreLink(from: string, to?: string): Promise<void> {
    const legacyPath = getVapiPaths(this.home).keystore;
    let info;
    try {
      info = await lstat(legacyPath);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (!info.isSymbolicLink()) return;
    const linked = resolvePath(this.home, await readlink(legacyPath));
    if (linked !== resolvePath(from)) return;
    await unlink(legacyPath);
    if (to === undefined) return;
    try {
      await symlink(join(WALLETS_DIRECTORY, basenameOf(to)), legacyPath);
    } catch {
      // See migrateLegacyLayout: the link is a convenience, not a requirement.
    }
  }

  private async update(mutate: (registry: WalletRegistry) => void): Promise<WalletRegistry> {
    const registry = await this.readRegistry();
    mutate(registry);
    await this.writeRegistry(registry);
    return this.snapshot();
  }

  private async readRegistry(): Promise<WalletRegistry> {
    let raw: string;
    try {
      raw = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return emptyRegistry();
      throw error;
    }
    try {
      return walletRegistrySchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new KeystoreError(
        `The wallet registry at ${this.registryPath} could not be read. Fix or move the file, then run vapi wallet list again.`,
        { cause: error },
      );
    }
  }

  private async writeRegistry(registry: WalletRegistry): Promise<void> {
    const parsed = walletRegistrySchema.parse(registry);
    await writeJsonFile(this.registryPath, parsed);
    this.registry = parsed;
  }
}

/**
 * The caps that apply to one wallet: its own entry, or — in a home that has no
 * registry yet — the legacy `config.spendCaps`, and otherwise the defaults.
 */
export async function spendCapsForWallet(
  store: WalletStore,
  name: WalletName = DEFAULT_WALLET_NAME,
): Promise<SpendCaps> {
  const entry = store.entry(name);
  if (entry) return { ...entry.spendCaps };
  return await readConfiguredSpendCaps(getVapiPaths(store.home).config);
}

/** Rejects anything that is not a wallet name, including path traversal. */
export function assertWalletName(value: string): WalletName {
  const name = value.trim();
  if (name === "." || name === ".." || /[/\\]/.test(name) || name.includes("\0")) {
    throw new KeystoreError(
      `A wallet name is a name, not a path: ${JSON.stringify(value)} cannot be used.`,
    );
  }
  if (!isWalletName(name)) {
    throw new KeystoreError(
      `Invalid wallet name ${JSON.stringify(value)}. Use 1 to 32 characters of lowercase letters, digits and dashes, starting with a letter or digit.`,
    );
  }
  return name;
}

function unknownWalletMessage(name: string, names: readonly string[]): string {
  if (names.length === 0) return "No wallet yet. Run vapi init.";
  return `No wallet named ${name}. This machine has: ${[...names].sort().join(", ")}.`;
}

function emptyRegistry(): WalletRegistry {
  return { version: 1, wallets: {} };
}

function entrySidecarPath(trashedPath: string): string {
  return `${trashedPath.slice(0, -".json".length)}.entry.json`;
}

function basenameOf(path: string): string {
  return path.slice(dirname(path).length + 1);
}

async function readEntrySidecar(path: string): Promise<WalletEntry | undefined> {
  try {
    const parsed = walletEntrySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The addresses a keystore names, without its passphrase. Only the encrypted
 * key material needs the passphrase, so `vapi wallet list` stays instant.
 */
async function readKeystoreSummary(
  path: string,
): Promise<{ address?: string; solanaAddress?: string; version?: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const address = Reflect.get(parsed, "address");
  const version = Reflect.get(parsed, "version");
  const keys: unknown = Reflect.get(parsed, "keys");
  const solana =
    typeof keys === "object" && keys !== null
      ? (Reflect.get(keys, "solana") as unknown)
      : undefined;
  const solanaAddress =
    typeof solana === "object" && solana !== null ? Reflect.get(solana, "address") : undefined;
  return {
    ...(typeof address === "string" ? { address } : {}),
    ...(typeof version === "number" ? { version } : {}),
    ...(typeof solanaAddress === "string" ? { solanaAddress } : {}),
  };
}

async function readConfiguredSpendCaps(configPath: string): Promise<SpendCaps> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    const caps =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "spendCaps") : undefined;
    const result = spendCapsSchema.safeParse(caps);
    if (result.success) return result.data;
  } catch {
    // A missing or unreadable config falls back to the shipped defaults.
  }
  return { ...DEFAULT_SPEND_CAPS };
}

function keystoreCreatedAt(info: { birthtimeMs: number; mtimeMs: number }): string {
  const stamp = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  return new Date(stamp).toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/** Temp file plus rename, mode 0600, the same write every keystore change uses. */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}
