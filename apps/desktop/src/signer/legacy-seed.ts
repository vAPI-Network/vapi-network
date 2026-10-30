import type { WalletStore } from "@vapi-network/core";

/** Spike vaults (before Phase 1) were created through this hidden first account. */
export const LEGACY_SEED_NAME = "owner-seed";
export const LEGACY_SEED_BALANCE_TIMEOUT_MS = 3000;

/**
 * Removes the spike's hidden `owner-seed` account once it is provably empty.
 * Core moves it to `wallets/.trash/`, so the record is kept. The default moves
 * to a real wallet first. A balance, a failed read, a link, or no other wallet
 * yet leaves it in place and hidden. Each balance read is bounded. Never throws.
 */
export async function retireLegacySeed(
  store: WalletStore,
  readBalance: (address: `0x${string}`) => Promise<bigint>,
  timeoutMs = LEGACY_SEED_BALANCE_TIMEOUT_MS,
): Promise<"removed" | "kept" | "absent"> {
  async function boundedReadBalance(address: `0x${string}`): Promise<bigint> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Legacy seed balance read timed out.")),
          timeoutMs,
        );
      });
      return await Promise.race([readBalance(address), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    await store.reload();
    if (!store.has(LEGACY_SEED_NAME)) return "absent";
    if (store.entry(LEGACY_SEED_NAME)?.link !== undefined) return "kept";
    const other = store.names().find((name) => name !== LEGACY_SEED_NAME);
    if (other === undefined) return "kept";
    const address = await store.readAddress(LEGACY_SEED_NAME);
    if (address === undefined) return "kept";
    if ((await boundedReadBalance(address as `0x${string}`)) !== 0n) return "kept";
    if (store.defaultName === LEGACY_SEED_NAME) await store.setDefault(other);
    await store.remove(LEGACY_SEED_NAME, {
      balanceReader: async (value) => await boundedReadBalance(value as `0x${string}`),
    });
    return "removed";
  } catch {
    return "kept";
  }
}
