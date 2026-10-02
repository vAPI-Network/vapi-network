import { describe, expect, it, vi } from "vitest";

import { LocalWallet } from "./wallet.js";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const SIGNATURE = `0x${"22".repeat(65)}` as const;

describe("local wallet abstraction", () => {
  it("delegates authorization to policy without exposing the private key", async () => {
    const authorize = vi.fn().mockResolvedValue(undefined);
    const signTypedData = vi.fn().mockResolvedValue(SIGNATURE);
    const wallet = new LocalWallet({ address: ADDRESS, signTypedData }, { authorize });
    const intent = {
      amountAtomic: 10n,
      network: "eip155:8453",
      payTo: ADDRESS,
      resourceUrl: "https://api.example/pay",
    } as const;

    await wallet.authorize(intent);

    expect(authorize).toHaveBeenCalledWith(intent);
    expect(wallet.address).toBe(ADDRESS);
    expect(wallet).not.toHaveProperty("privateKey");
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
