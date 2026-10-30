// apps/desktop/src/signer/emergency-kit.ts
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAudit,
  readVaultFileUnlocked,
  unlockProtectedVault,
  type SecretStore,
} from "@vapi-network/core";
import { exportVaultPhrase } from "@vapi-network/core/secrets";

export type RevealResult =
  | { ok: true; words: string[] }
  | { ok: false; code: "password_required" | "not_permitted"; message: string };

const KIT_FILE = "desktop-emergency-kit.json";

/**
 * The Emergency Kit (spec §4, §8): the vault's words, shown once per request behind the password,
 * with a cooldown and an audit line that never holds the words. "Done" is stored next to the vault
 * with a fingerprint of the sealed phrase, so a new vault starts as not done.
 */
export function createEmergencyKit(deps: {
  home: string;
  secrets: SecretStore;
  now?: () => Date;
  cooldownMs?: number;
  confirmWindowMs?: number;
}) {
  const vaultPath = join(deps.home, "vault.json");
  const kitPath = join(deps.home, KIT_FILE);
  const now = () => (deps.now?.() ?? new Date()).getTime();
  const cooldownMs = deps.cooldownMs ?? 10_000;
  const confirmWindowMs = deps.confirmWindowMs ?? 30 * 60_000;
  let lastRevealAt: number | undefined;
  let revealing = false;

  async function fingerprint(): Promise<string> {
    const file = await readVaultFileUnlocked(vaultPath);
    return createHash("sha256").update(file.phrase).digest("hex").slice(0, 32);
  }

  async function reveal(password: string): Promise<RevealResult> {
    if (revealing || (lastRevealAt !== undefined && now() - lastRevealAt < cooldownMs)) {
      return { ok: false, code: "not_permitted", message: "Wait a few seconds and try again." };
    }
    // Port messages can overlap while the password is being checked.
    revealing = true;
    try {
      let key: Uint8Array;
      try {
        key = await unlockProtectedVault({ path: vaultPath, secrets: deps.secrets, password });
      } catch {
        return { ok: false, code: "password_required", message: "That password is not right." };
      }
      let phrase: string;
      try {
        phrase = await exportVaultPhrase({ path: vaultPath, key });
      } finally {
        key.fill(0);
      }
      await appendAudit(
        deps.home,
        { event: "secret.export.phrase", tty: false, detail: "vAPI Desktop Emergency Kit" },
        { now: () => new Date(now()) },
      );
      lastRevealAt = now();
      return { ok: true, words: phrase.split(" ") };
    } finally {
      revealing = false;
    }
  }

  async function confirm(): Promise<boolean> {
    if (lastRevealAt === undefined || now() - lastRevealAt > confirmWindowMs) return false;
    const body = { v: 1, confirmedAt: new Date(now()).toISOString(), vault: await fingerprint() };
    await writeFile(kitPath, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    return true;
  }

  async function done(): Promise<boolean> {
    try {
      const stored = JSON.parse(await readFile(kitPath, "utf8")) as { vault?: unknown };
      return stored.vault === (await fingerprint());
    } catch {
      return false;
    }
  }

  return { reveal, confirm, done };
}
