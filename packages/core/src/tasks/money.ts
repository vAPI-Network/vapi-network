import { formatUsdc } from "../networks.js";

export type TaskMoneyAmount = { usd: string; baseUnits: string };
export type TaskMoney = {
  gross: TaskMoneyAmount;
  fee: TaskMoneyAmount | null;
  net: TaskMoneyAmount | null;
  feeBp: number | null;
  line: string;
};

/** Exact USDC decimal strings with at least two decimal places; no cent rounding. */
export function formatBaseUnitsUsd(baseUnits: bigint | string): string {
  const [whole, fraction = ""] = formatUsdc(parseBaseUnits(baseUnits)).split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

export function parseUsdToBaseUnits(text: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/u.test(text)) {
    throw new Error(
      "Task USD amount must be a non-negative decimal with at most six decimal places.",
    );
  }
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function parseFeeBp(deploymentOrReadiness: unknown): number | null {
  if (
    typeof deploymentOrReadiness !== "object" ||
    deploymentOrReadiness === null ||
    !("feeBp" in deploymentOrReadiness)
  ) {
    return null;
  }
  const feeBp = deploymentOrReadiness.feeBp;
  if (feeBp === undefined || feeBp === null) return null;
  validateFeeBp(feeBp);
  return feeBp;
}

export function taskMoney(grossBaseUnits: bigint | string, feeBp: number | null): TaskMoney {
  const atomic = parseBaseUnits(grossBaseUnits);
  const gross = amount(atomic);
  if (feeBp === null) {
    return { gross, fee: null, net: null, feeBp, line: `$${gross.usd} gross · fee unavailable` };
  }
  validateFeeBp(feeBp);
  // The contract floors the fee at one base unit, before formatting any USD.
  const feeAtomic = (atomic * BigInt(feeBp)) / 10_000n;
  const fee = amount(feeAtomic);
  const net = amount(atomic - feeAtomic);
  return {
    gross,
    fee,
    net,
    feeBp,
    line: `$${gross.usd} gross · $${fee.usd} fee · $${net.usd} net`,
  };
}

function amount(atomic: bigint): TaskMoneyAmount {
  return { usd: formatBaseUnitsUsd(atomic), baseUnits: atomic.toString() };
}

function validateFeeBp(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("Task fee basis points must be an integer from 0 to 10000.");
  }
}

function parseBaseUnits(value: bigint | string): bigint {
  if (
    (typeof value === "string" && !/^\d+$/u.test(value)) ||
    (typeof value !== "bigint" && typeof value !== "string")
  ) {
    throw new Error("Task base units must be a non-negative integer.");
  }
  const atomic = BigInt(value);
  if (atomic < 0n) throw new Error("Task base units must be a non-negative integer.");
  return atomic;
}

/** Floor policy USD to atomic units, including scientific notation, never round a cap up. */
export function taskPolicyAtomic(value: number): bigint {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Task policy USD amounts must be finite and non-negative.");
  const [mantissa = "0", exponent = "0"] = value.toString().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction);
  const scale = 6 + Number(exponent) - fraction.length;
  return scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
}
