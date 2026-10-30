import { spawn } from "node:child_process";

import type { PasswordStore } from "./signer.js";

export type Runner = (
  file: string,
  args: string[],
  input?: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const ACCOUNT = "vault-password";
const NOT_FOUND = 44;
/** errSecMissingEntitlement: ad-hoc signed builds have no Team ID, so no Data Protection Keychain. */
const MISSING_ENTITLEMENT = "-34018";

const spawnRunner: Runner = (file, args, input) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", () => resolve({ code: null, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });

/**
 * The vault password behind Touch ID. The helper is a signed Swift binary
 * that files the password in the Data Protection Keychain with a biometry-or-
 * passcode access control; the password reaches it on stdin, never in argv.
 * Without a helper (tests, Windows in the spike) the password lives in memory.
 */
export function keychainPasswordStore(
  helperPath: string | undefined,
  run: Runner = spawnRunner,
): PasswordStore {
  if (helperPath === undefined) {
    let value: string | undefined;
    return {
      async get() {
        return value;
      },
      async set(next) {
        value = next;
      },
      async delete() {
        value = undefined;
      },
    };
  }
  // Set when the keychain refuses us; the password then lives only for this session.
  let memory: string | undefined;
  return {
    async get() {
      if (memory !== undefined) return memory;
      const result = await run(helperPath, ["get", ACCOUNT]);
      if (result.code === NOT_FOUND) return undefined;
      if (result.code !== 0) throw new Error(`Keychain read failed: ${result.stderr.trim()}`);
      return result.stdout;
    },
    async set(value) {
      const result = await run(helperPath, ["set", ACCOUNT], `${value}\n`);
      if (result.code !== 0 && result.stderr.includes(MISSING_ENTITLEMENT)) {
        memory = value;
        return;
      }
      if (result.code !== 0) throw new Error(`Keychain write failed: ${result.stderr.trim()}`);
    },
    async delete() {
      memory = undefined;
      const result = await run(helperPath, ["delete", ACCOUNT]);
      const missing = result.stderr.includes(MISSING_ENTITLEMENT);
      if (result.code !== 0 && result.code !== NOT_FOUND && !missing) {
        throw new Error(`Keychain delete failed: ${result.stderr.trim()}`);
      }
    },
  };
}
