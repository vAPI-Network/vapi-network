import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, getAddress } from "viem";

import { EIP3009_AUTHORIZATION_STATE_ABI, checkReceiptSettlement } from "./authorization-state.js";
import { getDefaultConfig } from "./config.js";
import { BASE_MAINNET_CAIP2, SOLANA_MAINNET_CAIP2, SOLANA_MAINNET_USDC } from "./networks.js";
import type { Receipt } from "./receipts.js";

const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const PAYER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
const PAY_TO = getAddress("0x1111111111111111111111111111111111111111");
const NONCE = `0x${"ab".repeat(32)}` as const;
const VALID_BEFORE = 1_790_000_000;

function lostResponse(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: "receipt-lost",
    timestamp: "2026-09-21T10:00:00.000Z",
    resourceUrl: "https://vendor.example/paid",
    quote: { network: BASE_MAINNET_CAIP2, asset: USDC, amountAtomic: "2500", payTo: PAY_TO },
    payer: PAYER,
    authorization: { from: PAYER, nonce: NONCE, validBefore: String(VALID_BEFORE) },
    settlement: { outcome: "unknown" },
    outcome: "settlement_unknown",
    ...overrides,
  };
}

/** A JSON-RPC node that answers the two reads the check makes, and records them. */
function rpc(args: { used: boolean; chainTime: number }) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    calls.push({ method: request.method, params: request.params });
    const result =
      request.method === "eth_getBlockByNumber"
        ? {
            number: "0x10",
            hash: `0x${"cd".repeat(32)}`,
            parentHash: `0x${"00".repeat(32)}`,
            timestamp: `0x${args.chainTime.toString(16)}`,
            transactions: [],
          }
        : encodeFunctionResult({
            abi: EIP3009_AUTHORIZATION_STATE_ABI,
            functionName: "authorizationState",
            result: args.used,
          });
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  return { fetchImpl, calls };
}

describe("checkReceiptSettlement", () => {
  it("reads authorizationState(authorizer, nonce) on the receipt's own token", async () => {
    const node = rpc({ used: true, chainTime: VALID_BEFORE - 60 });

    const check = await checkReceiptSettlement(lostResponse(), getDefaultConfig(), {
      fetchImpl: node.fetchImpl,
    });

    expect(check).toEqual({
      network: BASE_MAINNET_CAIP2,
      token: USDC,
      authorizer: PAYER,
      nonce: NONCE,
      validBefore: String(VALID_BEFORE),
      chainTime: String(VALID_BEFORE - 60),
      state: "settled",
    });
    const call = node.calls.find((entry) => entry.method === "eth_call");
    const transaction = call?.params[0] as { to: string; data: `0x${string}` };
    expect(getAddress(transaction.to)).toBe(USDC);
    expect(
      decodeFunctionData({ abi: EIP3009_AUTHORIZATION_STATE_ABI, data: transaction.data }),
    ).toEqual({ functionName: "authorizationState", args: [PAYER, NONCE] });
  });

  it("calls an unused authorization expired once the chain is past validBefore", async () => {
    const atExpiry = rpc({ used: false, chainTime: VALID_BEFORE });
    await expect(
      checkReceiptSettlement(lostResponse(), getDefaultConfig(), {
        fetchImpl: atExpiry.fetchImpl,
      }),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("calls an unused authorization pending while the chain is before validBefore", async () => {
    const early = rpc({ used: false, chainTime: VALID_BEFORE - 1 });
    await expect(
      checkReceiptSettlement(lostResponse(), getDefaultConfig(), { fetchImpl: early.fetchImpl }),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("refuses a Solana receipt without touching an RPC", async () => {
    const node = rpc({ used: false, chainTime: 0 });
    await expect(
      checkReceiptSettlement(
        lostResponse({
          quote: {
            network: SOLANA_MAINNET_CAIP2,
            asset: SOLANA_MAINNET_USDC,
            amountAtomic: "2500",
          },
          authorization: undefined,
        }),
        getDefaultConfig(),
        { fetchImpl: node.fetchImpl },
      ),
    ).rejects.toThrow("checking a Solana payment's settlement is not supported yet");
    expect(node.fetchImpl).not.toHaveBeenCalled();
  });

  it("says so when a receipt predates the recorded authorization", async () => {
    await expect(
      checkReceiptSettlement(lostResponse({ authorization: undefined }), getDefaultConfig()),
    ).rejects.toThrow(
      `Receipt receipt-lost does not record its payment authorization — it was written before vAPI kept the EIP-3009 nonce on receipts — so its settlement cannot be looked up. Check ${PAYER}'s USDC transfers to ${PAY_TO} on a block explorer before paying again.`,
    );
  });

  it("says so when a call signed nothing at all", async () => {
    await expect(
      checkReceiptSettlement(
        lostResponse({ authorization: undefined, payer: undefined, outcome: "declined_policy" }),
        getDefaultConfig(),
      ),
    ).rejects.toThrow(
      "Receipt receipt-lost records no signed payment authorization, so nothing from that call can settle.",
    );
  });
});
