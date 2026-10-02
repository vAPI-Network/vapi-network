import type { Hex } from "viem";

import {
  AllocationError,
  formatUsdCents,
  parseUsdCents,
  planAllocation,
  type AllocationBlockReason,
} from "./allocation.js";
import { getVapiPaths, loadConfig } from "./config.js";
import {
  executeMovement,
  listUnfinishedMovements,
  MovementError,
  type Movement,
  type MovementAuthorizationStateReader,
  type MovementTransfer,
} from "./movement.js";
import type { LookupFn } from "./net-guard.js";
import { configuredNetworkFor } from "./networks.js";
import type { SecretStore } from "./secret-store.js";
import { fetchSiblings } from "./siblings.js";
import { readSpendLedger } from "./spend-policy.js";
import { readUsdcBalance } from "./sweep.js";
import type { TransferArgs, TransferNetwork } from "./transfer.js";
import { ARC_MAINNET_CAIP2, BASE_MAINNET_CAIP2 } from "./x402-networks.js";
import {
  assertWalletName,
  spendCapsForWallet,
  type WalletName,
  type WalletStore,
} from "./wallet-store.js";

export type DistributeBalanceReader = (input: {
  network: TransferNetwork;
  address: string;
}) => Promise<bigint>;

export type DistributeArgs = {
  store: WalletStore;
  secrets: SecretStore;
  apiBase: string;
  from?: string;
  amountUsd?: string | number;
  to?: readonly string[];
  network?: "base" | "arc" | TransferNetwork;
  resume?: string;
  home?: string;
  balanceReader?: DistributeBalanceReader;
  siblingsReader?: typeof fetchSiblings;
  transfer?: MovementTransfer;
  authorizationState?: MovementAuthorizationStateReader;
  now?: () => number;
  randomId?: () => string;
  randomNonce?: () => Hex;
  unlock?: TransferArgs["unlock"];
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  timeoutMs?: number;
  ledgerPath?: string;
  lockTimeoutMs?: number;
  replaceExpiredRestored?: boolean;
  bindLegacyAddresses?: boolean;
};

export type DistributeLegResult = {
  to: string;
  amountUsd: string;
  status: "sent" | "failed" | "unknown" | "cancelled";
  txHash?: string;
  reason?: string;
  nonce?: string;
};

export type DistributeResult = {
  movementId: string;
  from: WalletName;
  network: TransferNetwork;
  requestedUsd: string;
  legs: DistributeLegResult[];
  sentUsd: string;
  failedUsd: string;
  legacyAddressBindings?: {
    from: WalletName;
    to: string;
    fromAddress: string;
    toAddress: string;
  }[];
};

export type DistributeErrorCode =
  | "invalid_amount"
  | "invalid_network"
  | "invalid_recipients"
  | "resume_conflict"
  | "insufficient_balance"
  | "per_call_cap_exceeded"
  | "per_day_cap_exceeded"
  | "unfinished_movement"
  | "sender_not_found";

export class DistributeError extends Error {
  constructor(
    readonly code: DistributeErrorCode,
    message: string,
    readonly movementId?: string,
  ) {
    super(message);
    this.name = "DistributeError";
  }
}

export async function distributeBetweenAccounts(args: DistributeArgs): Promise<DistributeResult> {
  const home = args.home ?? args.store.home;
  if (args.resume !== undefined) {
    if (args.amountUsd !== undefined || args.to !== undefined) {
      throw new DistributeError(
        "resume_conflict",
        "A resumed distribution accepts no amount or recipients.",
        args.resume,
      );
    }
    return movementResult(
      await executeMovement({ resume: args.resume }, movementDependencies(args, home)),
    );
  }

  if (args.from === undefined) {
    throw new DistributeError("sender_not_found", "Choose the sending account with --from.");
  }
  const from = assertWalletName(args.from);
  if (args.amountUsd === undefined) {
    throw new DistributeError("invalid_amount", "Enter the amount to distribute.");
  }
  const network = resolveNetwork(args.network);
  const unfinished = await listUnfinishedMovements({ home, from });
  if (unfinished[0] !== undefined) throw unfinishedError(from, unfinished[0].id);

  await args.store.reload();
  const recipients =
    args.to === undefined
      ? await defaultRecipients(args, from)
      : args.to.map((recipient) => recipient.trim());
  if (recipients.length === 0 || recipients.some((recipient) => !recipient)) {
    throw new DistributeError("invalid_recipients", "No eligible recipient accounts were found.");
  }
  if (recipients.includes(from)) {
    throw new DistributeError(
      "invalid_recipients",
      `The sending account ${from} cannot also be a recipient.`,
    );
  }

  let amountCents: bigint;
  try {
    amountCents = parseUsdCents(args.amountUsd);
  } catch (error) {
    if (error instanceof AllocationError) {
      throw new DistributeError("invalid_amount", error.message);
    }
    throw error;
  }
  if (amountCents / BigInt(recipients.length) === 0n) {
    throw new DistributeError(
      "invalid_amount",
      `Amount too small to split over ${recipients.length} accounts.`,
    );
  }
  const amountAtomic = amountCents * 10_000n;
  const address = await args.store.readAddress(from);
  if (address === undefined) {
    throw new DistributeError("sender_not_found", `No local key was found for account ${from}.`);
  }
  const balanceAtomic = await readBalance(args, home, network, address);
  if (balanceAtomic < amountAtomic) {
    throw new DistributeError(
      "insufficient_balance",
      `Account ${from} has ${formatAtomicUsd(balanceAtomic)} USDC, short of the requested ${formatUsdCents(amountCents)} USDC.`,
    );
  }

  const caps = await spendCapsForWallet(args.store, from);
  const now = args.now ?? Date.now;
  const ledgerPath = args.ledgerPath ?? getVapiPaths(home).ledger;
  const ledger = await readSpendLedger(ledgerPath, new Date(now()), from);
  const perDayAtomic = BigInt(caps.perDayAtomic);
  const spentAtomic = BigInt(ledger.spentAtomic);
  const perDayRemainingAtomic = perDayAtomic > spentAtomic ? perDayAtomic - spentAtomic : 0n;
  const allocation = planAllocation({
    strategy: "even",
    from,
    recipients,
    amountUsd: formatUsdCents(amountCents),
    policy: {
      balanceAtomic,
      perCallAtomic: caps.perCallAtomic,
      perDayRemainingAtomic,
    },
  });
  if (allocation.blocked.length > 0) {
    const reason = preferredBlockReason(allocation.blocked.map((leg) => leg.reason));
    throw capError(
      reason,
      from,
      amountCents,
      spentAtomic,
      caps.perCallAtomic,
      caps.perDayAtomic,
      recipients.length,
    );
  }

  try {
    return movementResult(
      await executeMovement(
        { reason: "distribute", from, network, legs: allocation.legs },
        movementDependencies(args, home),
      ),
    );
  } catch (error) {
    if (error instanceof MovementError && error.code === "unfinished_movement") {
      throw unfinishedError(from, error.movementId ?? "unknown");
    }
    throw error;
  }
}

async function defaultRecipients(args: DistributeArgs, from: WalletName): Promise<string[]> {
  const siblingResult = await (args.siblingsReader ?? fetchSiblings)({
    apiBase: args.apiBase,
    account: from,
    secrets: args.secrets,
    wallets: args.store,
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  const activeAddresses = new Set(
    siblingResult.siblings
      .filter((sibling) => !sibling.self && sibling.status === "active")
      .map((sibling) => sibling.address.toLowerCase()),
  );
  const apiOrigin = safeOrigin(args.apiBase);
  const recipients: string[] = [];
  for (const name of args.store.names()) {
    if (name === from) continue;
    const entry = args.store.entry(name);
    if (entry?.link === undefined || safeOrigin(entry.link.apiBase) !== apiOrigin) continue;
    if (!(await args.store.hasVaultAccount(name))) continue;
    const address = await args.store.readAddress(name);
    if (address !== undefined && activeAddresses.has(address.toLowerCase())) recipients.push(name);
  }
  return recipients;
}

async function readBalance(
  args: DistributeArgs,
  home: string,
  network: TransferNetwork,
  address: string,
): Promise<bigint> {
  if (args.balanceReader !== undefined) return await args.balanceReader({ network, address });
  const config = await loadConfig(getVapiPaths(home).config);
  const configured = configuredNetworkFor(config.networks, network);
  if (configured === undefined) throw new Error(`Network ${network} is not configured.`);
  return await readUsdcBalance({
    network,
    configured,
    address,
    allowPrivateNetwork: config.allowPrivateNetwork,
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
    ...(args.lookup === undefined ? {} : { lookup: args.lookup }),
  });
}

function movementDependencies(args: DistributeArgs, home: string) {
  return {
    store: args.store,
    secrets: args.secrets,
    apiBase: args.apiBase,
    home,
    ...(args.transfer === undefined ? {} : { transfer: args.transfer }),
    ...(args.authorizationState === undefined
      ? {}
      : { authorizationState: args.authorizationState }),
    recipientAddressReader: async (from: WalletName, recipient: string) => {
      const siblings = await (args.siblingsReader ?? fetchSiblings)({
        apiBase: args.apiBase,
        account: from,
        secrets: args.secrets,
        wallets: args.store,
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        ...(args.now === undefined ? {} : { now: args.now }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      });
      if (recipient === "owner") return siblings.owner ?? undefined;
      const matches = siblings.siblings.filter(
        (sibling) => !sibling.self && sibling.status === "active" && sibling.name === recipient,
      );
      return matches.length === 1 ? matches[0]?.address : undefined;
    },
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.randomId === undefined ? {} : { randomId: args.randomId }),
    ...(args.randomNonce === undefined ? {} : { randomNonce: args.randomNonce }),
    ...(args.unlock === undefined ? {} : { unlock: args.unlock }),
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    ...(args.ledgerPath === undefined ? {} : { ledgerPath: args.ledgerPath }),
    ...(args.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: args.lockTimeoutMs }),
    ...(args.replaceExpiredRestored === undefined
      ? {}
      : { replaceExpiredRestored: args.replaceExpiredRestored }),
    ...(args.bindLegacyAddresses === undefined
      ? {}
      : { bindLegacyAddresses: args.bindLegacyAddresses }),
  };
}

function movementResult(movement: Movement): DistributeResult {
  const requestedCents = movement.legs.reduce(
    (total, leg) => total + parseUsdCents(leg.amountUsd),
    0n,
  );
  const sentCents = movement.legs.reduce(
    (total, leg) => total + (leg.status === "sent" ? parseUsdCents(leg.amountUsd) : 0n),
    0n,
  );
  const legs: DistributeLegResult[] = movement.legs.map((leg) => {
    const status = leg.status === "planned" ? "failed" : leg.status;
    return {
      to: leg.to,
      amountUsd: leg.amountUsd,
      status,
      ...(leg.txHash === undefined ? {} : { txHash: leg.txHash }),
      ...(leg.reason === undefined && leg.status !== "planned"
        ? {}
        : { reason: leg.reason ?? "not_attempted" }),
      nonce: leg.nonce,
    };
  });
  const legacyAddressBindings = movement.legs.flatMap((leg) =>
    leg.addressBindingSource === "terminal-review" &&
    leg.fromAddress !== undefined &&
    leg.toAddress !== undefined
      ? [
          {
            from: leg.from,
            to: leg.to,
            fromAddress: leg.fromAddress,
            toAddress: leg.toAddress,
          },
        ]
      : [],
  );
  return {
    movementId: movement.id,
    from: movement.from,
    network: movement.network,
    requestedUsd: formatUsdCents(requestedCents),
    legs,
    sentUsd: formatUsdCents(sentCents),
    failedUsd: formatUsdCents(requestedCents - sentCents),
    ...(legacyAddressBindings.length === 0 ? {} : { legacyAddressBindings }),
  };
}

function capError(
  reason: "per_call_cap_exceeded" | "per_day_cap_exceeded",
  from: WalletName,
  amountCents: bigint,
  spentAtomic: bigint,
  perCallAtomic: string,
  perDayAtomic: string,
  recipients: number,
): DistributeError {
  const share = amountCents / BigInt(recipients);
  const largestAtomic = (share + (amountCents % BigInt(recipients))) * 10_000n;
  const suggestedPerCall =
    largestAtomic > BigInt(perCallAtomic) ? largestAtomic : BigInt(perCallAtomic);
  const requiredPerDay = spentAtomic + amountCents * 10_000n;
  const suggestedPerDay =
    requiredPerDay > BigInt(perDayAtomic) ? requiredPerDay : BigInt(perDayAtomic);
  const command = `vapi accounts caps ${from} --per-call ${formatAtomicUsd(suggestedPerCall)} --per-day ${formatAtomicUsd(suggestedPerDay)}`;
  return new DistributeError(
    reason,
    `The ${reason === "per_call_cap_exceeded" ? "per-call" : "per-day"} cap is too low. Raise it with: ${command}`,
  );
}

function preferredBlockReason(
  reasons: readonly AllocationBlockReason[],
): "per_call_cap_exceeded" | "per_day_cap_exceeded" {
  return reasons.includes("per_day_cap_exceeded")
    ? "per_day_cap_exceeded"
    : "per_call_cap_exceeded";
}

function unfinishedError(from: WalletName, id: string): DistributeError {
  return new DistributeError(
    "unfinished_movement",
    `Account ${from} has unfinished movement ${id}. Resume it with vapi accounts distribute --resume ${id}.`,
    id,
  );
}

function resolveNetwork(value: DistributeArgs["network"]): TransferNetwork {
  if (value === undefined || value === "base" || value === BASE_MAINNET_CAIP2) {
    return BASE_MAINNET_CAIP2;
  }
  if (value === "arc" || value === ARC_MAINNET_CAIP2) return ARC_MAINNET_CAIP2;
  throw new DistributeError("invalid_network", "Choose the Base or Arc transfer network.");
}

function formatAtomicUsd(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  let fraction = (atomic % 1_000_000n).toString().padStart(6, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${whole}.${fraction}`;
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
