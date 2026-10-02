import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_AGENT_SCOPES,
  AgentLinkError,
  pollDeviceLink as completeDeviceLink,
  saveAgentLink as storeAgentLink,
  startDeviceLink as beginDeviceLink,
  trustedLinkBearer,
  type LinkResult,
} from "./agent-link.js";
import { DEFAULT_SPEND_CAPS, getVapiPaths, isMissingFile, type SpendCaps } from "./config.js";
import { ensureDeviceName } from "./device.js";
import { KeystoreError } from "./keystore.js";
import { formatUsdc } from "./networks.js";
import type { SecretStore } from "./secret-store.js";
import { assertWalletName, type WalletName, type WalletStore } from "./wallet-store.js";
import { usdToAtomic } from "./x402.js";

export type AccountCapsUsd = {
  perCallUsd: string;
  perDayUsd: string;
};

export type AccountCapsInput = {
  perCallUsd?: number | string;
  perDayUsd?: number | string;
};

type CreatedAccount = {
  account: WalletName;
  address: string;
  caps: AccountCapsUsd;
  created: boolean;
};

export type AccountLinkOutcome =
  | { linked: true; owner: string }
  | { linked: false; reason: "denied" | "expired" | "failed"; message: string };

export type AccountLinkResult = {
  linked: boolean;
  autoApproved: boolean;
  link?: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresInSeconds: number;
  };
  linkError?: string;
  completion?: Promise<AccountLinkOutcome>;
};

export type AccountAddResult = CreatedAccount & AccountLinkResult;

export class AccountCapsRaiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountCapsRaiseError";
  }
}

export function linkRouterAllowanceUsd(args: {
  scopes: readonly string[];
  explicitUsd?: number | undefined;
  perDayCapUsd?: number | string | undefined;
  trusted: boolean;
}): number | undefined {
  if (!args.scopes.includes("router.use")) return undefined;
  if (args.explicitUsd !== undefined) return args.explicitUsd;
  if (!args.trusted || args.perDayCapUsd === undefined) return undefined;
  return Number(formatUsdc(usdToAtomic(args.perDayCapUsd)));
}

export async function createAccount(args: {
  store: WalletStore;
  name: string;
  caps?: AccountCapsInput;
  label?: string;
  existing?: "refuse" | "return";
}): Promise<CreatedAccount> {
  const name = assertWalletName(args.name);
  await args.store.reload();
  const current = args.store.entry(name);
  if (current !== undefined) {
    if (args.existing !== "return") {
      throw new KeystoreError(`Wallet ${name} already exists. Choose another name.`);
    }
    return {
      account: name,
      address: await requireAddress(args.store, name),
      caps: displayCaps(current.spendCaps),
      created: false,
    };
  }

  if (!(await fileExists(join(args.store.home, "vault.json")))) {
    throw new KeystoreError("No vault yet. Run vapi setup.");
  }
  const spendCaps = resolveNewAccountCaps(args.caps);
  const {
    name: createdName,
    account: { address },
  } = await args.store.create(name, "", {
    spendCaps,
    ...(args.label === undefined ? {} : { label: args.label }),
  });
  return {
    account: createdName,
    address,
    caps: displayCaps(spendCaps),
    created: true,
  };
}

export async function lowerAccountCaps(args: {
  store: WalletStore;
  name: string;
  perCallUsd?: number | string;
  perDayUsd?: number | string;
}): Promise<{
  account: WalletName;
  address: string;
  caps: AccountCapsUsd;
  changed: boolean;
}> {
  if (args.perCallUsd === undefined && args.perDayUsd === undefined) {
    throw new Error("Set at least one of perCallUsd or perDayUsd.");
  }
  const name = assertWalletName(args.name);
  const requestedCall =
    args.perCallUsd === undefined ? undefined : parseCap("perCallUsd", args.perCallUsd);
  const requestedDay =
    args.perDayUsd === undefined ? undefined : parseCap("perDayUsd", args.perDayUsd);
  let changed = false;
  const entry = await args.store.updateSpendCaps(name, (current) => {
    const raisedFlags = [
      ...(requestedCall !== undefined && requestedCall > BigInt(current.perCallAtomic)
        ? [` --per-call ${formatUsdc(requestedCall)}`]
        : []),
      ...(requestedDay !== undefined && requestedDay > BigInt(current.perDayAtomic)
        ? [` --per-day ${formatUsdc(requestedDay)}`]
        : []),
    ];
    if (raisedFlags.length > 0) {
      throw new AccountCapsRaiseError(
        `Raise caps in the terminal: vapi accounts caps ${name}${raisedFlags.join("")}`,
      );
    }

    let perCallAtomic = requestedCall ?? BigInt(current.perCallAtomic);
    const perDayAtomic = requestedDay ?? BigInt(current.perDayAtomic);
    if (args.perCallUsd === undefined && perCallAtomic > perDayAtomic) {
      perCallAtomic = perDayAtomic;
    }
    if (perCallAtomic > perDayAtomic) {
      throw new Error("perCallUsd cannot exceed perDayUsd.");
    }
    const spendCaps = {
      perCallAtomic: perCallAtomic.toString(),
      perDayAtomic: perDayAtomic.toString(),
    };
    changed =
      spendCaps.perCallAtomic !== current.perCallAtomic ||
      spendCaps.perDayAtomic !== current.perDayAtomic;
    return spendCaps;
  });
  return {
    account: name,
    address: await requireAddress(args.store, name),
    caps: displayCaps(entry.spendCaps),
    changed,
  };
}

export type AddAccountArgs = {
  store: WalletStore;
  secrets: SecretStore;
  name: string;
  caps?: AccountCapsInput;
  label?: string;
  existing?: "refuse" | "return";
  link?: boolean;
  apiBase: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  /**
   * Explicit router allowance for `router.use`. Without one, a trusted link
   * requests the account's exact per-day cap; an untrusted link leaves the
   * allowance for the owner to choose on the consent page.
   */
  routerAllowanceUsd?: number;
  scopes?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  startDeviceLink?: typeof beginDeviceLink;
  pollDeviceLink?: typeof completeDeviceLink;
  saveAgentLink?: typeof storeAgentLink;
};

export type StartAccountLinkArgs = Omit<AddAccountArgs, "name" | "caps" | "existing" | "link"> & {
  account: WalletName;
  /** Start the owner flow without polling when false. Defaults to true. */
  awaitApproval?: boolean;
};

export async function addAccount(args: AddAccountArgs): Promise<AccountAddResult> {
  const account = await createAccount({
    store: args.store,
    name: args.name,
    ...(args.caps === undefined ? {} : { caps: args.caps }),
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(args.existing === undefined ? {} : { existing: args.existing }),
  });
  const base = { ...account, autoApproved: false };
  if (!account.created) {
    return { ...base, linked: args.store.entry(account.account)?.link !== undefined };
  }
  if (args.link === false) return { ...base, linked: false };
  if (!args.secrets.available) {
    return {
      ...base,
      linked: false,
      linkError:
        "No OS secret store is available on this machine, so the agent link cannot be stored safely. Nothing was started.",
    };
  }

  const link = await startAccountLink({ ...args, account: account.account });
  return { ...account, ...link };
}

export async function startAccountLink(args: StartAccountLinkArgs): Promise<AccountLinkResult> {
  const base = { autoApproved: false };
  if (!args.secrets.available) {
    return {
      ...base,
      linked: false,
      linkError:
        "No OS secret store is available on this machine, so the agent link cannot be stored safely. Nothing was started.",
    };
  }

  const startLink = args.startDeviceLink ?? beginDeviceLink;
  const pollLink = args.pollDeviceLink ?? completeDeviceLink;
  const saveLink = args.saveAgentLink ?? storeAgentLink;
  const label = args.label ?? args.account;
  const scopes = args.scopes ?? [...DEFAULT_AGENT_SCOPES];
  let start: Awaited<ReturnType<typeof beginDeviceLink>>;
  let bearer: string | undefined;
  try {
    const device = await ensureDeviceName({
      ...(args.env === undefined ? {} : { env: args.env }),
      ...(args.hostname === undefined ? {} : { hostname: args.hostname }),
      configPath: args.configPath ?? getVapiPaths(args.store.home).config,
    });
    bearer = await trustedLinkBearer({
      store: args.store,
      secrets: args.secrets,
      apiBase: args.apiBase,
      exclude: args.account,
      ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
      ...(args.now === undefined ? {} : { now: args.now }),
    });
    const perDayCapUsd = formatUsdc(
      BigInt(args.store.resolve({ name: args.account }).entry.spendCaps.perDayAtomic),
    );
    const routerAllowanceUsd = linkRouterAllowanceUsd({
      scopes,
      explicitUsd: args.routerAllowanceUsd,
      perDayCapUsd,
      trusted: bearer !== undefined,
    });
    const signer = await args.store.unlock(args.account, "");
    start = await startLink({
      apiBase: args.apiBase,
      account: signer,
      label,
      scopes,
      device,
      trustDevice: true,
      ...(bearer === undefined ? {} : { bearer }),
      ...(routerAllowanceUsd === undefined ? {} : { routerAllowanceUsd }),
      ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
      ...(args.now === undefined ? {} : { now: () => new Date(args.now!()) }),
    });
  } catch (error) {
    return {
      ...base,
      linked: false,
      linkError: publicErrorMessage(error, "The vAPI agent link could not be started.", [bearer]),
    };
  }

  const link = {
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    verificationUriComplete: start.verificationUriComplete,
    expiresInSeconds: start.expiresIn,
  };
  if (args.awaitApproval === false) {
    // Even an auto-approved device exchange uses pollDeviceLink, which owns an
    // expiry timer and may loop. A no-wait caller starts no polling at all.
    return { linked: false, autoApproved: start.autoApproved, link };
  }

  if (start.autoApproved) {
    let result: LinkResult | undefined;
    try {
      result = await pollLink({
        apiBase: args.apiBase,
        start,
        immediate: true,
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        ...(args.now === undefined ? {} : { now: args.now }),
        ...(args.sleep === undefined ? { sleep: unrefSleep } : { sleep: args.sleep }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
      await saveLink({
        secrets: args.secrets,
        wallets: args.store,
        wallet: args.account,
        start,
        result,
        apiBase: args.apiBase,
        label,
        home: args.store.home,
      });
      return { linked: true, autoApproved: true };
    } catch (error) {
      return {
        linked: false,
        autoApproved: true,
        linkError: publicErrorMessage(error, "The vAPI agent link did not complete.", [
          start.deviceCode,
          result?.tokens.accessToken,
          result?.tokens.refreshToken,
          result?.routerKey,
        ]),
      };
    }
  }

  const completion = completeAndSave({
    args,
    start,
    account: args.account,
    label,
    pollLink,
    saveLink,
  });
  return {
    ...base,
    linked: false,
    link,
    completion,
  };
}

async function completeAndSave(options: {
  args: StartAccountLinkArgs;
  start: Awaited<ReturnType<typeof beginDeviceLink>>;
  account: WalletName;
  label: string;
  pollLink: typeof completeDeviceLink;
  saveLink: typeof storeAgentLink;
}): Promise<AccountLinkOutcome> {
  let result: LinkResult | undefined;
  try {
    result = await options.pollLink({
      apiBase: options.args.apiBase,
      start: options.start,
      ...(options.args.fetchImpl === undefined ? {} : { fetchImpl: options.args.fetchImpl }),
      ...(options.args.now === undefined ? {} : { now: options.args.now }),
      ...(options.args.sleep === undefined ? { sleep: unrefSleep } : { sleep: options.args.sleep }),
      ...(options.args.signal === undefined ? {} : { signal: options.args.signal }),
    });
    await options.saveLink({
      secrets: options.args.secrets,
      wallets: options.args.store,
      wallet: options.account,
      start: options.start,
      result,
      apiBase: options.args.apiBase,
      label: options.label,
      home: options.args.store.home,
    });
    return { linked: true, owner: result.owner };
  } catch (error) {
    return {
      linked: false,
      reason:
        error instanceof AgentLinkError && error.code === "access_denied"
          ? "denied"
          : error instanceof AgentLinkError && error.code === "expired_token"
            ? "expired"
            : "failed",
      message: publicErrorMessage(error, "The vAPI agent link did not complete.", [
        options.start.deviceCode,
        result?.tokens.accessToken,
        result?.tokens.refreshToken,
        result?.routerKey,
      ]),
    };
  }
}

function resolveNewAccountCaps(input: AccountCapsInput | undefined): SpendCaps {
  let perCallAtomic =
    input?.perCallUsd === undefined
      ? BigInt(DEFAULT_SPEND_CAPS.perCallAtomic)
      : parseCap("perCallUsd", input.perCallUsd);
  const perDayAtomic =
    input?.perDayUsd === undefined
      ? BigInt(DEFAULT_SPEND_CAPS.perDayAtomic)
      : parseCap("perDayUsd", input.perDayUsd);
  if (input?.perCallUsd === undefined && perCallAtomic > perDayAtomic) {
    perCallAtomic = perDayAtomic;
  }
  if (perCallAtomic > perDayAtomic) {
    throw new Error("perCallUsd cannot exceed perDayUsd.");
  }
  return {
    perCallAtomic: perCallAtomic.toString(),
    perDayAtomic: perDayAtomic.toString(),
  };
}

function parseCap(field: "perCallUsd" | "perDayUsd", value: number | string): bigint {
  try {
    return usdToAtomic(value);
  } catch {
    throw new Error(`${field} must be a non-negative USD amount with at most 6 decimals.`);
  }
}

function displayCaps(caps: SpendCaps): AccountCapsUsd {
  return {
    perCallUsd: formatUsdc(BigInt(caps.perCallAtomic)),
    perDayUsd: formatUsdc(BigInt(caps.perDayAtomic)),
  };
}

async function requireAddress(store: WalletStore, name: WalletName): Promise<string> {
  const address = await store.readAddress(name);
  if (address === undefined) throw new KeystoreError(`No key for wallet ${name} in the vault.`);
  return address;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function publicErrorMessage(
  error: unknown,
  fallback: string,
  sensitiveValues: readonly (string | undefined)[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.length === 0 ||
    sensitiveValues.some(
      (value) => value !== undefined && value.length > 0 && message.includes(value),
    ) ||
    /device[_ -]?code|(?:access|refresh)[_ -]?token|router[_ -]?key|bearer\s|(?:0x)?[0-9a-f]{64}/iu.test(
      message,
    )
  ) {
    return fallback;
  }
  return error instanceof Error ? message : fallback;
}

async function unrefSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    if (signal === undefined) return;
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}
