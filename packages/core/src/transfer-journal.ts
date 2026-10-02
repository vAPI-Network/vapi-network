import { readFile } from "node:fs/promises";

import { getVapiPaths, isMissingFile } from "./config.js";
import { parseReceipt, receiptWallet, type Receipt } from "./receipts.js";
import type { WalletName } from "./wallet-name.js";

export type TransferJournal = {
  signed: boolean;
  latest?: Receipt;
  request?: Receipt;
  validBefore?: string;
  reservedOn?: string;
};

export async function readTransferJournal(
  home: string,
  from: WalletName,
  nonce: string,
): Promise<TransferJournal> {
  let raw: string;
  try {
    raw = await readFile(getVapiPaths(home).receipts, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { signed: false };
    throw error;
  }
  let latest: Receipt | undefined;
  let request: Receipt | undefined;
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let receipt: Receipt;
    try {
      receipt = parseReceipt(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid receipt on JSONL line ${index + 1}.`, { cause: error });
    }
    if (
      receiptWallet(receipt) !== from ||
      receipt.transfer?.nonce.toLowerCase() !== nonce.toLowerCase()
    ) {
      continue;
    }
    latest = receipt;
    if (receipt.transfer.request !== undefined) request = receipt;
  }
  return {
    signed: latest !== undefined,
    ...(latest === undefined ? {} : { latest }),
    ...(request === undefined ? {} : { request }),
    ...(request?.transfer?.request?.authorization.validBefore === undefined
      ? {}
      : { validBefore: request.transfer.request.authorization.validBefore }),
    ...((latest?.transfer?.reservedOn ?? request?.transfer?.reservedOn) === undefined
      ? {}
      : { reservedOn: latest?.transfer?.reservedOn ?? request?.transfer?.reservedOn }),
  };
}
