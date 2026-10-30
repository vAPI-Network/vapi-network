import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySecretStore, WalletStore } from "@vapi-network/core";

import { LEGACY_SEED_NAME, retireLegacySeed } from "./legacy-seed.js";

describe("retireLegacySeed", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "legacy-seed-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(home, { recursive: true, force: true });
  });

  async function spikeStore(withWallet = true): Promise<WalletStore> {
    const store = await WalletStore.open(home, { secrets: memorySecretStore() });
    await store.create(LEGACY_SEED_NAME, "");
    if (withWallet) await store.create("claude", "");
    return store;
  }

  it("removes an empty seed and moves the default to the real wallet", async () => {
    const store = await spikeStore();
    expect(store.defaultName).toBe(LEGACY_SEED_NAME);
    expect(await retireLegacySeed(store, async () => 0n)).toBe("removed");
    expect(store.names()).toEqual(["claude"]);
    expect(store.defaultName).toBe("claude");
    const trash = await readdir(join(home, "wallets", ".trash"));
    expect(trash).toContainEqual(
      expect.stringMatching(/^owner-seed-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.json$/),
    );
  });

  it("keeps a seed that holds money", async () => {
    const store = await spikeStore();
    expect(await retireLegacySeed(store, async () => 1n)).toBe("kept");
    expect(store.names()).toContain(LEGACY_SEED_NAME);
    expect(store.defaultName).toBe(LEGACY_SEED_NAME);
  });

  it("keeps a linked seed without reading its balance", async () => {
    const store = await spikeStore();
    await store.setLink(LEGACY_SEED_NAME, {
      apiBase: "https://api.vapinetwork.ai",
      clientId: "linked-seed",
      owner: "0x0000000000000000000000000000000000000001",
      label: "Spike wallet",
      scopes: [],
      linkedAt: "2026-10-26T00:00:00.000Z",
    });
    const readBalance = vi.fn(async () => 0n);
    expect(await retireLegacySeed(store, readBalance)).toBe("kept");
    expect(readBalance).not.toHaveBeenCalled();
    expect(store.names()).toContain(LEGACY_SEED_NAME);
    expect(store.defaultName).toBe(LEGACY_SEED_NAME);
  });

  it("keeps the seed when the balance cannot be read", async () => {
    const store = await spikeStore();
    const result = await retireLegacySeed(store, async () => {
      throw new Error("rpc down");
    });
    expect(result).toBe("kept");
    expect(store.names()).toContain(LEGACY_SEED_NAME);
  });

  it("keeps the seed and default when the balance read never resolves", async () => {
    const store = await spikeStore();
    const readBalance = vi.fn(() => new Promise<bigint>(() => {}));
    expect(await retireLegacySeed(store, readBalance, 20)).toBe("kept");
    await store.reload();
    expect(store.names()).toEqual([LEGACY_SEED_NAME, "claude"]);
    expect(store.defaultName).toBe(LEGACY_SEED_NAME);
  }, 1000);

  it("also bounds the balance read in core's removal guard", async () => {
    const store = await spikeStore();
    const readBalance = vi.fn(() => new Promise<bigint>(() => {})).mockResolvedValueOnce(0n);
    expect(await retireLegacySeed(store, readBalance, 20)).toBe("kept");
    await store.reload();
    expect(store.names()).toContain(LEGACY_SEED_NAME);
    expect(readBalance).toHaveBeenCalledTimes(2);
  }, 1000);

  it.each(["resolves", "rejects"])("clears the balance timer when the read %s", async (outcome) => {
    const store = await spikeStore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const readBalance = async () => {
      if (outcome === "rejects") throw new Error("rpc down");
      return 0n;
    };
    expect(await retireLegacySeed(store, readBalance)).toBe(
      outcome === "rejects" ? "kept" : "removed",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the seed while it is the only account", async () => {
    const store = await spikeStore(false);
    expect(await retireLegacySeed(store, async () => 0n)).toBe("kept");
  });

  it("reports absent for a vault created without it", async () => {
    const store = await WalletStore.open(home, { secrets: memorySecretStore() });
    await store.create("claude", "");
    expect(await retireLegacySeed(store, async () => 0n)).toBe("absent");
  });
});
