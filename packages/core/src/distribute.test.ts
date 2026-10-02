import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";

import { distributeBetweenAccounts, type DistributeArgs } from "./distribute.js";
import { listUnfinishedMovements } from "./movement.js";
import type { SecretStore } from "./secret-store.js";
import type { Sibling } from "./siblings.js";
import { TransferError, type TransferArgs, type TransferResult } from "./transfer.js";
import type { WalletEntry, WalletStore } from "./wallet-store.js";
import { BASE_MAINNET_CAIP2 } from "./x402-networks.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const ID = "mv_distribute01";
const NONCES = ["11", "22", "33"].map((byte) => `0x${byte.repeat(32)}` as Hex);
const ADDRESSES = {
  sender: getAddress("0x1000000000000000000000000000000000000001"),
  one: getAddress("0x2000000000000000000000000000000000000002"),
  two: getAddress("0x3000000000000000000000000000000000000003"),
  three: getAddress("0x4000000000000000000000000000000000000004"),
};
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("distributeBetweenAccounts", () => {
  it("refuses a second distribute after a crash and resumes the stored nonces only", async () => {
    const home = await temporaryHome();
    const store = fakeStore(home);
    let resumePhase = false;
    let signatures = 0;
    const calls: TransferArgs[] = [];
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      calls.push(args);
      if (args.to === "two" && !resumePhase) throw new Error("simulated crash");
      signatures += 1;
      return sentResult(args);
    });
    const args = baseArgs(home, store, transfer);

    await expect(distributeBetweenAccounts(args)).rejects.toThrow("simulated crash");
    const [unfinished] = await listUnfinishedMovements({ home, from: "sender" });
    expect(unfinished).toMatchObject({ id: ID, pendingLegs: 2, unknownLegs: 0 });

    await expect(distributeBetweenAccounts(args)).rejects.toMatchObject({
      code: "unfinished_movement",
      movementId: ID,
      message: expect.stringContaining(`vapi accounts distribute --resume ${ID}`),
    });

    resumePhase = true;
    const result = await distributeBetweenAccounts({
      store,
      secrets: {} as SecretStore,
      apiBase: "https://api.vapinetwork.ai",
      home,
      resume: ID,
      transfer,
      now: () => NOW,
    });
    expect(result.legs.map((leg) => leg.status)).toEqual(["sent", "sent", "sent"]);
    expect(signatures).toBe(3);
    expect(calls.slice(-2).map((call) => ({ to: call.to, nonce: call.nonce }))).toEqual([
      { to: "two", nonce: NONCES[1] },
      { to: "three", nonce: NONCES[2] },
    ]);
  });

  it("reports a failed middle leg, continues serially, and totals sent versus failed", async () => {
    const home = await temporaryHome();
    const store = fakeStore(home);
    const order: string[] = [];
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      order.push(args.to);
      if (args.to === "two") {
        throw new TransferError("relay_failed", "The relay refused it.", {
          reservationReleased: true,
        });
      }
      return sentResult(args);
    });

    const result = await distributeBetweenAccounts(baseArgs(home, store, transfer));

    expect(order).toEqual(["one", "two", "three"]);
    expect(result).toMatchObject({
      requestedUsd: "3.00",
      sentUsd: "2.00",
      failedUsd: "1.00",
      legs: [
        { to: "one", status: "sent" },
        { to: "two", status: "failed", reason: "relay_failed" },
        { to: "three", status: "sent" },
      ],
    });
  });

  it.each([
    [
      "insufficient balance",
      { balance: 2_990_000n, caps: { perCallAtomic: "10000000", perDayAtomic: "10000000" } },
      "insufficient_balance",
      "short of the requested",
    ],
    [
      "per-call cap",
      { balance: 10_000_000n, caps: { perCallAtomic: "990000", perDayAtomic: "10000000" } },
      "per_call_cap_exceeded",
      "vapi accounts caps sender --per-call 1.00 --per-day 10.00",
    ],
    [
      "per-day cap",
      { balance: 10_000_000n, caps: { perCallAtomic: "10000000", perDayAtomic: "2990000" } },
      "per_day_cap_exceeded",
      "vapi accounts caps sender --per-call 10.00 --per-day 3.00",
    ],
  ])("pre-flights %s without signing", async (_label, setup, code, message) => {
    const home = await temporaryHome();
    const store = fakeStore(home, setup.caps);
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => sentResult(args));

    await expect(
      distributeBetweenAccounts({
        ...baseArgs(home, store, transfer),
        balanceReader: async () => setup.balance,
      }),
    ).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
    expect(transfer).not.toHaveBeenCalled();
  });

  it("defaults to other linked active local accounts in vault order", async () => {
    const home = await temporaryHome();
    const store = fakeStore(
      home,
      undefined,
      ["sender", "three", "one", "two"],
      new Set(["sender", "three", "one"]),
    );
    const order: string[] = [];
    const transfer = vi.fn(async (args: TransferArgs): Promise<TransferResult> => {
      order.push(args.to);
      return sentResult(args);
    });
    const siblingsReader = vi.fn(async () => ({
      owner: null,
      source: { account: "sender" as const },
      siblings: [
        sibling("sender", ADDRESSES.sender, { self: true }),
        sibling("one", ADDRESSES.one),
        sibling("two", ADDRESSES.two),
        sibling("three", ADDRESSES.three),
      ],
    }));

    const result = await distributeBetweenAccounts({
      ...baseArgs(home, store, transfer),
      to: undefined,
      amountUsd: "2.00",
      siblingsReader,
    });

    expect(order).toEqual(["three", "one"]);
    expect(result.legs.map((leg) => leg.to)).toEqual(["three", "one"]);
  });

  it("rejects no recipient, the sender as recipient, and resume arguments", async () => {
    const noRecipientHome = await temporaryHome();
    const noRecipientStore = fakeStore(noRecipientHome, undefined, ["sender"]);
    await expect(
      distributeBetweenAccounts({
        ...baseArgs(noRecipientHome, noRecipientStore, async (args) => sentResult(args)),
        to: undefined,
        siblingsReader: async () => ({
          owner: null,
          source: { account: "sender" },
          siblings: [],
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_recipients" });

    const senderHome = await temporaryHome();
    await expect(
      distributeBetweenAccounts({
        ...baseArgs(senderHome, fakeStore(senderHome), async (args) => sentResult(args)),
        to: ["sender"],
      }),
    ).rejects.toMatchObject({ code: "invalid_recipients" });

    await expect(
      distributeBetweenAccounts({
        ...baseArgs(senderHome, fakeStore(senderHome), async (args) => sentResult(args)),
        resume: ID,
      }),
    ).rejects.toMatchObject({ code: "resume_conflict" });
  });
});

function baseArgs(
  home: string,
  store: WalletStore,
  transfer: NonNullable<DistributeArgs["transfer"]>,
): DistributeArgs {
  let nonceIndex = 0;
  return {
    store,
    secrets: {} as SecretStore,
    apiBase: "https://api.vapinetwork.ai",
    home,
    from: "sender",
    to: ["one", "two", "three"],
    amountUsd: "3.00",
    balanceReader: async () => 100_000_000n,
    transfer,
    now: () => NOW,
    randomId: () => ID,
    randomNonce: () => NONCES[nonceIndex++]!,
  };
}

function fakeStore(
  home: string,
  caps = { perCallAtomic: "10000000", perDayAtomic: "10000000" },
  names = ["sender", "one", "two", "three"],
  linked = new Set(names),
): WalletStore {
  const entries = Object.fromEntries(
    names.map((name) => [
      name,
      {
        createdAt: "2026-09-29T09:00:00.000Z",
        spendCaps: caps,
        ...(linked.has(name)
          ? {
              link: {
                apiBase: "https://api.vapinetwork.ai",
                clientId: `agent_${name}`,
                owner: getAddress("0x9999999999999999999999999999999999999999"),
                label: name,
                scopes: [],
                linkedAt: "2026-09-29T09:00:00.000Z",
              },
            }
          : {}),
      } satisfies WalletEntry,
    ]),
  ) as Record<string, WalletEntry>;
  const addresses: Record<string, string> = ADDRESSES;
  return {
    home,
    reload: async () => ({ version: 1, default: "sender", wallets: entries }),
    names: () => [...names],
    entry: (name: string) => entries[name],
    hasVaultAccount: async (name: string) => names.includes(name),
    readAddress: async (name: string) => addresses[name],
  } as unknown as WalletStore;
}

function sibling(
  name: string,
  address: `0x${string}`,
  options: { self?: boolean; status?: "active" | "revoked" } = {},
): Sibling {
  return {
    name,
    address,
    device: "test-device",
    status: options.status ?? "active",
    allowance: { routerPerDayUsd: null, perCallUsd: null, perDayUsd: null },
    self: options.self ?? false,
  };
}

function sentResult(args: TransferArgs): TransferResult {
  return {
    status: "sent",
    from: args.from,
    to: ADDRESSES.one,
    toName: args.to,
    toKind: "account",
    amountUsd: String(args.amountUsd),
    amountAtomic: "1000000",
    network: BASE_MAINNET_CAIP2,
    txHash: `0x${"ab".repeat(32)}`,
    nonce: args.resume ?? args.nonce ?? NONCES[0]!,
    replayed: args.resume !== undefined,
  };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-distribute-"));
  homes.push(home);
  return home;
}
