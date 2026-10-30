import type { Hex } from "viem";
import { toAccount } from "viem/accounts";

import type { VapiPaymentAccount } from "./keystore.js";

/**
 * A payment account whose private key lives in another process. Every
 * signature request crosses `request`; the holder of the key decides whether
 * to answer. The desktop app's MCP host uses this so a prompt-injected tool
 * call can ask for a payment but never see the key.
 */
export type RemoteSignRequest =
  | { kind: "typedData"; wallet: string; typedData: unknown }
  | { kind: "message"; wallet: string; message: string };

export type RemoteAccountArgs = {
  wallet: string;
  address: Hex;
  publicKey: Hex;
  request: (message: RemoteSignRequest) => Promise<Hex>;
};

export class RemoteAccountError extends Error {
  constructor(
    public readonly code: "not_permitted",
    message: string,
  ) {
    super(message);
    this.name = "RemoteAccountError";
  }
}

const notPermitted = (what: string) =>
  new RemoteAccountError("not_permitted", `${what} is not permitted through vAPI Desktop.`);

export function remotePaymentAccount(args: RemoteAccountArgs): VapiPaymentAccount {
  const base = toAccount({
    address: args.address,
    async signMessage({ message }) {
      const text = typeof message === "string" ? message : JSON.stringify(message);
      return await args.request({ kind: "message", wallet: args.wallet, message: text });
    },
    async signTransaction() {
      throw notPermitted("Raw transaction signing");
    },
    async signTypedData(typedData: unknown) {
      return await args.request({ kind: "typedData", wallet: args.wallet, typedData });
    },
  });
  const account = {
    ...base,
    publicKey: args.publicKey,
    source: "privateKey" as const,
    async sign() {
      throw notPermitted("Hash signing");
    },
    async signAuthorization() {
      throw notPermitted("EIP-7702 authorization");
    },
  };
  return account as unknown as VapiPaymentAccount;
}
