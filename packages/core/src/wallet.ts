import type { Address, Hex } from "viem";

import { getVapiPaths } from "./config.js";
import { unlockKeystore } from "./keystore.js";
import type { ConfiguredNetwork } from "./networks.js";
import type { PaymentIntent, Policy } from "./policy.js";
import { readUsdcBalance } from "./sweep.js";
import type { X402TypedData } from "./x402.js";

export interface Signer {
  readonly address: Address;
  signTypedData(typedData: X402TypedData): Promise<Hex>;
}

/** Local wallet seam: policy authorization is explicit and precedes signing. */
export interface Wallet extends Signer {
  authorize(intent: PaymentIntent): Promise<void>;
  balance(network: string, configured: ConfiguredNetwork): Promise<bigint>;
}

export class LocalWallet implements Wallet {
  readonly address: Address;

  constructor(
    private readonly account: Signer,
    private readonly policy: Policy,
  ) {
    this.address = account.address;
  }

  async authorize(intent: PaymentIntent): Promise<void> {
    await this.policy.authorize(intent);
  }

  async signTypedData(typedData: X402TypedData): Promise<Hex> {
    return await this.account.signTypedData(typedData);
  }

  async balance(network: string, configured: ConfiguredNetwork): Promise<bigint> {
    return await readUsdcBalance({ network, configured, address: this.address });
  }
}

export async function openWallet(options: {
  passphrase: string;
  policy: Policy;
  keystorePath?: string;
}): Promise<Wallet> {
  const account = await unlockKeystore(
    options.passphrase,
    options.keystorePath ?? getVapiPaths().keystore,
  );
  return new LocalWallet(account, options.policy);
}
