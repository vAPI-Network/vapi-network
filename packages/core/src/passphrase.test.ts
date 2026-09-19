import { describe, expect, it, vi } from "vitest";

import { resolvePassphrase } from "./passphrase.js";
import { KeystoreError, type SecretStore } from "./index.js";

/** A secret store that answers from a map and records what it was asked. */
function fakeStore(entries: Record<string, string>, overrides: Partial<SecretStore> = {}) {
  const asked: string[] = [];
  const store: SecretStore = {
    available: true,
    platform: "darwin",
    description: "the macOS Keychain",
    get: async (name) => {
      asked.push(name);
      return entries[name];
    },
    has: async (name) => entries[name] !== undefined,
    set: async (name, passphrase) => {
      entries[name] = passphrase;
    },
    remove: async (name) => delete entries[name],
    ...overrides,
  };
  return { store, asked };
}

describe("resolvePassphrase", () => {
  it("takes VAPI_KEYSTORE_PASSWORD first and never touches the store", async () => {
    const { store, asked } = fakeStore({ main: "from-the-keychain" });
    const prompt = vi.fn();

    const resolved = await resolvePassphrase("main", {
      env: { VAPI_KEYSTORE_PASSWORD: "from-the-environment" },
      store,
      prompt,
    });

    expect(resolved).toEqual({ passphrase: "from-the-environment", source: "environment" });
    expect(asked).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses an empty environment variable", async () => {
    const { store } = fakeStore({});

    await expect(
      resolvePassphrase("main", { env: { VAPI_KEYSTORE_PASSWORD: "" }, store }),
    ).rejects.toThrow("VAPI_KEYSTORE_PASSWORD cannot be empty.");
  });

  it("reads the secret store for that wallet when the variable is absent", async () => {
    const { store, asked } = fakeStore({ main: "main-passphrase", agent: "agent-passphrase" });
    const prompt = vi.fn();

    const resolved = await resolvePassphrase("agent", { env: {}, store, prompt });

    expect(resolved).toEqual({ passphrase: "agent-passphrase", source: "secret-store" });
    expect(asked).toEqual(["agent"]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts when neither the variable nor the store has one", async () => {
    const { store } = fakeStore({});
    const prompt = vi.fn(async () => "typed-passphrase");

    const resolved = await resolvePassphrase("main", { env: {}, store, prompt });

    expect(resolved).toEqual({ passphrase: "typed-passphrase", source: "prompt" });
    expect(prompt).toHaveBeenCalledWith(
      "Passphrase for main: ",
      expect.stringContaining("vapi unlock --wallet main"),
    );
  });

  it("falls through to the prompt when the store cannot be reached", async () => {
    const { store } = fakeStore(
      {},
      {
        get: async () => {
          throw new KeystoreError("secret-tool is not installed");
        },
      },
    );
    const prompt = vi.fn(async () => "typed-passphrase");

    const resolved = await resolvePassphrase("main", { env: {}, store, prompt });

    expect(resolved.source).toBe("prompt");
  });

  it("skips the store and asks twice when a passphrase is being set", async () => {
    const { store, asked } = fakeStore({ main: "from-the-keychain" });
    const prompt = vi.fn(async (_prompt: string) => "new-passphrase");

    const resolved = await resolvePassphrase("main", { env: {}, store, prompt, confirm: true });

    expect(resolved).toEqual({ passphrase: "new-passphrase", source: "prompt" });
    expect(asked).toEqual([]);
    expect(prompt.mock.calls.map((call) => call[0])).toEqual([
      "Passphrase for main: ",
      "Confirm passphrase: ",
    ]);
  });

  it("refuses a confirmation that does not match", async () => {
    const { store } = fakeStore({});
    const answers = ["one-passphrase", "another-passphrase"];
    const prompt = vi.fn(async () => answers.shift()!);

    await expect(
      resolvePassphrase("main", { env: {}, store, prompt, confirm: true }),
    ).rejects.toThrow("Passphrases do not match.");
  });

  it("names both routes out when nothing is watching the terminal", async () => {
    const { store } = fakeStore({});
    const prompt = vi.fn();

    await expect(
      resolvePassphrase("agent-claude", { env: {}, store, prompt, interactive: false }),
    ).rejects.toThrow(
      "No interactive terminal is available for the keystore prompt. Set VAPI_KEYSTORE_PASSWORD, or store this wallet's passphrase once with vapi unlock --wallet agent-claude.",
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it("leaves an unavailable store alone", async () => {
    const { store, asked } = fakeStore({ main: "from-the-keychain" }, { available: false });
    const prompt = vi.fn(async () => "typed-passphrase");

    const resolved = await resolvePassphrase("main", { env: {}, store, prompt });

    expect(resolved.source).toBe("prompt");
    expect(asked).toEqual([]);
  });
});
