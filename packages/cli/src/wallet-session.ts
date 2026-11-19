import {
  activeAgentMarker,
  appendAudit,
  type AuditEvent,
  getVapiPaths,
  KeystoreError,
  promptForSecret,
  type ResolvedPassphrase,
  resolvePassphrase,
  secretsAllowed,
  type SecretsDecision,
  secretStore,
  type SecretStore,
  staleStoredPassphraseMessage,
  type VapiPaymentAccount,
  type WalletEntry,
  type WalletName,
  WalletStore,
} from "@vapi-network/core";

import { WALLET_OPTION } from "./args.js";
import {
  type CliDependencies,
  type CliIo,
  getEnvironment,
  getLinePrompt,
  isInteractive,
} from "./cli-context.js";

/** The wallet one invocation acts on, resolved before any passphrase is read. */
export type WalletTarget = {
  store: WalletStore;
  name: WalletName;
  path: string;
  entry: WalletEntry;
  address?: string;
};

/** Opens the wallet store for this home, migrating a 0.2.x layout on the way. */
export async function openWalletStore(
  dependencies: CliDependencies,
  home = getVapiPaths().directory,
): Promise<WalletStore> {
  return await WalletStore.open(home, {
    secrets: getSecretStore(dependencies),
    env: getEnvironment(dependencies),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}

/**
 * `--account`, then `VAPI_WALLET`, then the default in `wallets.json`. An
 * unknown name fails here, before a passphrase prompt can cost anything.
 */
export async function selectWallet(
  store: WalletStore,
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
): Promise<WalletTarget> {
  const requested = parsed.one(WALLET_OPTION);
  const resolved = store.resolve({
    ...(requested === undefined ? {} : { name: requested }),
    env: getEnvironment(dependencies),
  });
  const address = await store.readAddress(resolved.name);
  return { store, ...resolved, ...(address === undefined ? {} : { address }) };
}

/** Opens the store and picks the wallet in one step, for the usual command. */
export async function targetWallet(
  parsed: { one(name: string): string | undefined },
  dependencies: CliDependencies,
  home = getVapiPaths().directory,
): Promise<WalletTarget> {
  return await selectWallet(await openWalletStore(dependencies, home), parsed, dependencies);
}

/** The OS secret store this run uses: the machine's, or the one a test injects. */
export function getSecretStore(dependencies: CliDependencies): SecretStore {
  return dependencies.secretStore ?? secretStore();
}

/**
 * The passphrase for the wallet this command acts on: `VAPI_KEYSTORE_PASSWORD`,
 * then the OS secret store entry `vapi unlock` left behind, then a prompt.
 *
 * The variable is read from the real process environment rather than from the
 * injected one: it belongs to the process, while `dependencies.env` models
 * wallet selection and agent markers.
 */
export async function walletPassphrase(
  target: { name: string },
  dependencies: CliDependencies,
  options: { confirm?: boolean } = {},
): Promise<ResolvedPassphrase> {
  const prompts = dependencies.prompts;
  return await resolvePassphrase(target.name, {
    env: process.env,
    store: getSecretStore(dependencies),
    ...(dependencies.interactive === undefined ? {} : { interactive: dependencies.interactive }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    prompt: async (prompt, hint) =>
      prompts ? await prompts.secret(prompt) : await promptForSecret(prompt, hint),
  });
}

/**
 * Runs one keystore operation with a resolved passphrase. A passphrase that
 * came out of the secret store and no longer opens the wallet is worth its own
 * sentence: the person has to know which copy went stale, and how to replace it.
 */
export async function withResolvedPassphrase<T>(
  resolved: ResolvedPassphrase,
  target: { name: string },
  dependencies: CliDependencies,
  use: (passphrase: string) => Promise<T>,
): Promise<T> {
  try {
    return await use(resolved.passphrase);
  } catch (error) {
    if (resolved.source !== "secret-store" || !(error instanceof KeystoreError)) throw error;
    throw new KeystoreError(
      staleStoredPassphraseMessage(target.name, getSecretStore(dependencies)),
      { cause: error },
    );
  }
}

/** Opens the selected wallet, and keeps the passphrase for callers that need it. */
export async function unlockTarget(
  target: WalletTarget,
  dependencies: CliDependencies,
): Promise<{ account: VapiPaymentAccount; passphrase: string }> {
  if (await target.store.hasVaultAccount(target.name)) {
    return { account: await target.store.unlock(target.name, ""), passphrase: "" };
  }
  const resolved = await walletPassphrase(target, dependencies);
  const account = await withResolvedPassphrase(resolved, target, dependencies, (passphrase) =>
    target.store.unlock(target.name, passphrase),
  );
  return { account, passphrase: resolved.passphrase };
}

export function walletHeader(target: { name: string; address?: string }): string {
  return target.address === undefined
    ? `Wallet: ${target.name}`
    : `Wallet: ${target.name} (${target.address})`;
}

/**
 * The shape every wallet-aware command prints: the wallet name first in text
 * mode, and a `wallet` field in `--json`, so a person and an agent always know
 * which key just moved.
 */
export function outputForWallet(
  io: CliIo,
  json: boolean,
  target: { name: string; address?: string },
  value: Record<string, unknown>,
  human: string,
): void {
  if (json) {
    io.stdout(JSON.stringify({ wallet: target.name, ...value }));
    return;
  }
  io.stdout(walletHeader(target));
  io.stdout(human);
}

const AGENT_SECRET_REFUSAL =
  "Run this yourself in a terminal; an agent must never see these words.";

/** Whether this run may put a recovery phrase or a private key on the screen. */
export function secretsDecision(dependencies: CliDependencies): SecretsDecision {
  const interactive = dependencies.interactive;
  return secretsAllowed(getEnvironment(dependencies), {
    stdinIsTTY: interactive ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY: interactive ?? Boolean(process.stdout.isTTY),
  });
}

/** One audit line. The home is the wallet store's, so `VAPI_HOME` is honoured. */
export async function recordAudit(
  dependencies: CliDependencies,
  event: AuditEvent | "vault.cloud_backup_on" | "vault.cloud_backup_off",
  options: { wallet?: string; detail?: string } = {},
): Promise<void> {
  const marker = activeAgentMarker(getEnvironment(dependencies));
  await appendAudit(getVapiPaths().directory, {
    event: event as AuditEvent,
    ...(options.wallet === undefined ? {} : { wallet: options.wallet }),
    tty: isInteractive(dependencies),
    ...(marker === undefined ? {} : { agentMarker: marker }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  });
}

/**
 * The gate in front of `vapi backup` and `vapi export-key`: refuse, log the
 * attempt, and say which stream or which variable decided it. Nothing is
 * printed to stdout, so a caller capturing it gets nothing either way.
 */
export async function requireSecretsAllowed(
  dependencies: CliDependencies,
  event: AuditEvent,
  wallet: string | undefined,
  options: { refusal?: string; forcedReason?: string } = {},
): Promise<void> {
  const decision = secretsDecision(dependencies);
  if (decision.allowed && options.forcedReason === undefined) return;
  const reason = decision.allowed ? options.forcedReason : decision.reason;
  await recordAudit(dependencies, event, {
    ...(wallet === undefined ? {} : { wallet }),
    detail: `refused: ${reason ?? ""}`,
  });
  throw new KeystoreError(`${options.refusal ?? AGENT_SECRET_REFUSAL} ${reason ?? ""}`.trim());
}

/**
 * Printing a secret or trashing a wallet is worth one deliberate act: the
 * person types the wallet's own name. A mismatch stops before anything moves.
 */
export async function confirmWalletName(
  name: string,
  prompt: string,
  refusal: string,
  dependencies: CliDependencies,
): Promise<void> {
  const typed = await getLinePrompt(dependencies)(prompt);
  if (typed.trim() !== name) throw new KeystoreError(refusal);
}
