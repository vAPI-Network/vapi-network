const ATOMIC = 1_000_000n;

/** USDC atomic units (6 decimals) as dollars: cents always, sub-cent digits only when present. */
export function formatUsd(atomic: string | bigint): string {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const whole = value / ATOMIC;
  const fraction = (value % ATOMIC).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${whole.toLocaleString("en-US")}.${fraction.padEnd(2, "0")}`;
}

/** "$1.50" → "1500000"; `undefined` for anything that is not a non-negative amount. */
export function parseUsdToAtomic(input: string): string | undefined {
  const match = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (match === null) return undefined;
  const [, whole = "0", fraction = ""] = match;
  return (BigInt(whole) * ATOMIC + BigInt(fraction.padEnd(6, "0"))).toString();
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
