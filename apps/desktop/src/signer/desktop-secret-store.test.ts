// apps/desktop/src/signer/desktop-secret-store.test.ts
import { describe, expect, it } from "vitest";
import { memorySecretStore, VAULT_KEY_ACCOUNT, VAULT_SESSION_ACCOUNT } from "@vapi-network/core";

import { desktopSecretStore } from "./desktop-secret-store.js";

const TOKENS = "vapi.agent.claude.tokens";

describe("desktopSecretStore", () => {
  it("keeps the vault key and session in this process's memory only", async () => {
    const os = memorySecretStore();
    const store = desktopSecretStore({ home: "/tmp/cli", defaultHome: "/tmp/cli", os });
    await store.set(VAULT_KEY_ACCOUNT, "key");
    await store.set(VAULT_SESSION_ACCOUNT, "session");
    expect(await store.get(VAULT_KEY_ACCOUNT)).toBe("key");
    expect(await os.list?.()).toEqual([]);
  });

  it("files link tokens under the CLI's own names in the CLI home", async () => {
    const os = memorySecretStore();
    const store = desktopSecretStore({ home: "/tmp/cli", defaultHome: "/tmp/cli", os });
    await store.set(TOKENS, "t");
    expect(await os.get(TOKENS)).toBe("t");
  });

  it("prefixes entries for any other home so it never overwrites the CLI's tokens", async () => {
    const os = memorySecretStore();
    const store = desktopSecretStore({ home: "/tmp/spike", defaultHome: "/tmp/cli", os });
    await store.set(TOKENS, "t");
    expect(await os.get(TOKENS)).toBeUndefined();
    expect(await os.list?.()).toEqual([
      expect.stringMatching(/^vapi-desktop\.[0-9a-f]{12}\.vapi\.agent\.claude\.tokens$/),
    ]);
    expect(await store.get(TOKENS)).toBe("t");
    expect(await store.has(TOKENS)).toBe(true);
    expect(await store.remove(TOKENS)).toBe(true);
  });

  it("forgets the vault key after a restart and keeps the link tokens", async () => {
    const os = memorySecretStore();
    const before = desktopSecretStore({ home: "/tmp/cli", defaultHome: "/tmp/cli", os });
    await before.set(VAULT_KEY_ACCOUNT, "key");
    await before.set(TOKENS, "t");
    const after = desktopSecretStore({ home: "/tmp/cli", defaultHome: "/tmp/cli", os });
    expect(await after.get(VAULT_KEY_ACCOUNT)).toBeUndefined();
    expect(await after.get(TOKENS)).toBe("t");
  });
});
