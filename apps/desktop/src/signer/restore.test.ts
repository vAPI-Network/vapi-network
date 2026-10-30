import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveEvmPrivateKey,
  generateRecoveryPhrase,
  memorySecretStore,
  phraseToSeed,
  readVaultFileUnlocked,
} from "@vapi-network/core";
import { privateKeyToAccount } from "viem/accounts";

import { normalizePhrase } from "../shared/phrase.js";
import { restoreFromPhrase } from "./restore.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vapi-restore-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function addressAt(phrase: string, index: number) {
  const seed = phraseToSeed(phrase);
  try {
    return privateKeyToAccount(deriveEvmPrivateKey(seed, `m/44'/60'/0'/0/${index}`)).address;
  } finally {
    seed.fill(0);
  }
}

describe("restoreFromPhrase", () => {
  it("normalises pasted words", () => {
    expect(normalizePhrase("  Abandon\n ability,  ABLE\t")).toBe("abandon ability able");
    expect(normalizePhrase("1. abandon 2. ability")).toBe("abandon ability");
  });

  it("restores funded accounts into a password-protected vault", async () => {
    const phrase = generateRecoveryPhrase();
    const funded = new Set([addressAt(phrase, 0), addressAt(phrase, 2)]);
    const result = await restoreFromPhrase({
      home,
      secrets: memorySecretStore(),
      phrase,
      password: "correct horse",
      probe: async (address) => funded.has(address),
    });
    expect(result.wallets).toEqual(["account-1", "account-2", "account-3"]);
    expect((await readVaultFileUnlocked(join(home, "vault.json"))).protected).toBe(true);
    const log = await readFile(join(home, "audit.log"), "utf8");
    expect(log).toContain("vault.restore");
    expect(log).not.toContain(phrase);
    expect(log).not.toContain("correct horse");
  });

  it("refuses bad words and an existing vault", async () => {
    await expect(
      restoreFromPhrase({
        home,
        secrets: memorySecretStore(),
        phrase: "not real words",
        password: "correct horse",
        probe: async () => false,
      }),
    ).rejects.toMatchObject({ code: "bad_phrase" });
    const phrase = generateRecoveryPhrase();
    await restoreFromPhrase({
      home,
      secrets: memorySecretStore(),
      phrase,
      password: "correct horse",
      probe: async () => false,
    });
    await expect(
      restoreFromPhrase({
        home,
        secrets: memorySecretStore(),
        phrase,
        password: "correct horse",
        probe: async () => false,
      }),
    ).rejects.toMatchObject({ code: "vault_exists" });
  });

  it("leaves no vault behind when the balance check fails", async () => {
    await expect(
      restoreFromPhrase({
        home,
        secrets: memorySecretStore(),
        phrase: generateRecoveryPhrase(),
        password: "correct horse",
        probe: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toMatchObject({ code: "probe_failed" });
    await expect(readFile(join(home, "vault.json"))).rejects.toThrow();
  });
});
