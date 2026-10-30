import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";

import {
  remotePaymentAccount,
  RemoteAccountError,
  type RemoteSignRequest,
} from "./remote-account.js";
import { EIP3009_AUTHORIZATION_TYPES } from "./x402.js";

const typedData = {
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
  },
  types: EIP3009_AUTHORIZATION_TYPES,
  primaryType: "TransferWithAuthorization" as const,
  message: {
    from: "0x0000000000000000000000000000000000000001" as const,
    to: "0x0000000000000000000000000000000000000002" as const,
    value: 10_000n,
    validAfter: 0n,
    validBefore: 1_900_000_000n,
    nonce: `0x${"11".repeat(32)}` as const,
  },
};

describe("remotePaymentAccount", () => {
  it("signs typed data through the request function and matches a local account", async () => {
    const local = privateKeyToAccount(generatePrivateKey());
    const seen: RemoteSignRequest[] = [];
    const remote = remotePaymentAccount({
      wallet: "claude",
      address: local.address,
      publicKey: local.publicKey,
      request: async (message) => {
        seen.push(message);
        if (message.kind !== "typedData") throw new Error("unexpected");
        return await local.signTypedData(message.typedData as typeof typedData);
      },
    });

    const signature = await remote.signTypedData(typedData);
    expect(signature).toBe(await local.signTypedData(typedData));
    expect(seen).toEqual([{ kind: "typedData", wallet: "claude", typedData }]);
    expect(await verifyTypedData({ ...typedData, address: local.address, signature })).toBe(true);
    expect(remote.address).toBe(local.address);
    expect(remote.source).toBe("privateKey");
  });

  it("refuses raw transaction signing", async () => {
    const local = privateKeyToAccount(generatePrivateKey());
    const remote = remotePaymentAccount({
      wallet: "claude",
      address: local.address,
      publicKey: local.publicKey,
      request: async () => "0x",
    });
    await expect(
      remote.signTransaction({ chainId: 8453, to: local.address, value: 0n, type: "eip1559" }),
    ).rejects.toBeInstanceOf(RemoteAccountError);
  });
});
