import type { Address } from "viem";

import type { SpendCaps } from "./config.js";
import { reserveSpend, type SpendLedger } from "./spend-policy.js";

export type PaymentIntent = Readonly<{
  amountAtomic: bigint;
  network: string;
  payTo: Address;
  resourceUrl?: string;
}>;

/** A payment policy is always evaluated before a signature is requested. */
export interface Policy {
  authorize(intent: PaymentIntent): Promise<void>;
}

export class SpendPolicy implements Policy {
  constructor(
    public readonly caps: SpendCaps,
    private readonly options: { ledgerPath?: string; now?: () => Date } = {},
  ) {}

  async authorize(intent: PaymentIntent): Promise<void> {
    await this.reserve(intent.amountAtomic);
  }

  async reserve(amountAtomic: bigint): Promise<SpendLedger> {
    return await reserveSpend(amountAtomic, this.caps, {
      ...(this.options.ledgerPath ? { ledgerPath: this.options.ledgerPath } : {}),
      ...(this.options.now ? { now: this.options.now() } : {}),
    });
  }
}
