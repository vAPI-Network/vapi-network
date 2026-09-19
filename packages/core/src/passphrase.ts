import { KeystoreError, promptForSecret } from "./keystore.js";
import { secretStore, type SecretStore } from "./secret-store.js";

/**
 * Where the passphrase of a wallet comes from, in one place.
 *
 * The order is `VAPI_KEYSTORE_PASSWORD`, then the OS secret store, then a
 * prompt on a real terminal. The environment variable stays first so CI keeps
 * working; the secret store is what lets an editor's MCP configuration hold no
 * secret at all; the prompt is for a person, and a run with no terminal says
 * how to arrange one of the other two instead.
 */

export const PASSPHRASE_ENVIRONMENT_VARIABLE = "VAPI_KEYSTORE_PASSWORD";

/** Which of the three routes actually produced the passphrase. */
export type PassphraseSource = "environment" | "secret-store" | "prompt";

export type ResolvedPassphrase = {
  passphrase: string;
  source: PassphraseSource;
};

export type ResolvePassphraseOptions = {
  /** The environment to read `VAPI_KEYSTORE_PASSWORD` from. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The OS secret store to consult. Defaults to this platform's. */
  store?: SecretStore | undefined;
  /** Reads one line without echoing it. Defaults to the terminal prompt. */
  prompt?: ((prompt: string, noTerminalHint?: string) => Promise<string>) | undefined;
  /** False when nobody is watching, so the prompt is refused before it starts. */
  interactive?: boolean | undefined;
  /**
   * Ask twice. A passphrase that is being set rather than used never comes
   * from the secret store, so this also skips it.
   */
  confirm?: boolean | undefined;
};

/** The two ways out of a run that cannot prompt, named for the wallet at hand. */
export function noPassphraseHint(walletName: string): string {
  return `Set ${PASSPHRASE_ENVIRONMENT_VARIABLE}, or store this wallet's passphrase once with vapi unlock --wallet ${walletName}.`;
}

/**
 * The message for a stored passphrase that no longer opens its wallet — the
 * shape of a passphrase changed on one machine while another kept the old one.
 */
export function staleStoredPassphraseMessage(walletName: string, store: SecretStore): string {
  return [
    `The passphrase stored in ${store.description} no longer opens wallet ${walletName}.`,
    `Store the current one with vapi unlock --wallet ${walletName}, or remove it with vapi lock --wallet ${walletName}.`,
  ].join(" ");
}

/**
 * The passphrase for one wallet: environment, then secret store, then prompt.
 * A secret store that cannot be reached — no keyring installed, a locked
 * session — is not fatal here; the prompt, or the error that names both other
 * routes, is the better answer than a failure a person cannot act on.
 */
export async function resolvePassphrase(
  walletName: string,
  options: ResolvePassphraseOptions = {},
): Promise<ResolvedPassphrase> {
  const env = options.env ?? process.env;
  const fromEnvironment = env[PASSPHRASE_ENVIRONMENT_VARIABLE];
  if (fromEnvironment !== undefined) {
    if (fromEnvironment.length === 0) {
      throw new KeystoreError(`${PASSPHRASE_ENVIRONMENT_VARIABLE} cannot be empty.`);
    }
    return { passphrase: fromEnvironment, source: "environment" };
  }

  if (options.confirm !== true) {
    const stored = await readStored(options.store ?? secretStore(), walletName);
    if (stored !== undefined) return { passphrase: stored, source: "secret-store" };
  }

  const hint = noPassphraseHint(walletName);
  if (options.interactive === false) {
    throw new KeystoreError(
      `No interactive terminal is available for the keystore prompt. ${hint}`,
    );
  }
  const prompt = options.prompt ?? promptForSecret;
  const first = await prompt(`Passphrase for ${walletName}: `, hint);
  if (first.length === 0) {
    throw new KeystoreError("Keystore passphrase cannot be empty.");
  }
  if (options.confirm === true) {
    const second = await prompt("Confirm passphrase: ", hint);
    if (first !== second) throw new KeystoreError("Passphrases do not match.");
  }
  return { passphrase: first, source: "prompt" };
}

/** A store that will not answer is the same as a store with nothing in it. */
async function readStored(store: SecretStore, walletName: string): Promise<string | undefined> {
  if (!store.available) return undefined;
  try {
    return await store.get(walletName);
  } catch {
    return undefined;
  }
}
