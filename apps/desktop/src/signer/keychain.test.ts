import { describe, expect, it } from "vitest";
import { keychainPasswordStore, type Runner } from "./keychain.js";

function fakeRunner(values: Record<string, string>): Runner & { calls: string[][] } {
  const runner = (async (_file: string, args: string[], input?: string) => {
    runner.calls.push(args);
    const [verb, account] = args;
    if (verb === "get") {
      const value = values[account ?? ""];
      return value === undefined
        ? { code: 44, stdout: "", stderr: "" }
        : { code: 0, stdout: value, stderr: "" };
    }
    if (verb === "set") {
      values[account ?? ""] = (input ?? "").replace(/\n$/, "");
      return { code: 0, stdout: "", stderr: "" };
    }
    const existed = account !== undefined && account in values;
    if (account !== undefined) delete values[account];
    return { code: existed ? 0 : 44, stdout: "", stderr: "" };
  }) as Runner & { calls: string[][] };
  runner.calls = [];
  return runner;
}

describe("keychainPasswordStore", () => {
  it("round-trips the password through the helper and passes it on stdin", async () => {
    const run = fakeRunner({});
    const store = keychainPasswordStore("/app/vapi-keychain", run);
    expect(await store.get()).toBeUndefined();
    await store.set("correct horse battery");
    expect(run.calls.at(-1)).toEqual(["set", "vault-password"]);
    expect(await store.get()).toBe("correct horse battery");
    await store.delete();
    expect(await store.get()).toBeUndefined();
  });

  it("falls back to memory when no helper is configured", async () => {
    const store = keychainPasswordStore(undefined);
    await store.set("x");
    expect(await store.get()).toBe("x");
  });

  it("keeps the password in memory when the helper lacks the keychain entitlement", async () => {
    // Ad-hoc signed builds get errSecMissingEntitlement; the user types the password each unlock.
    const run: Runner = async (_file, args) =>
      args[0] === "get"
        ? { code: 44, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "keychain write failed: -34018\n" };
    const store = keychainPasswordStore("/app/vapi-keychain", run);
    await store.set("x");
    expect(await store.get()).toBe("x");
    await store.delete();
    expect(await store.get()).toBeUndefined();
  });

  it("still fails on other keychain write errors", async () => {
    const run: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "keychain write failed: -25308",
    });
    await expect(keychainPasswordStore("/app/vapi-keychain", run).set("x")).rejects.toThrow(
      "-25308",
    );
  });
});
