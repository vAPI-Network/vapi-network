import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVault,
  memorySecretStore,
  readAuditLog,
  validateRecoveryPhrase,
} from "@vapi-network/core";

import { createEmergencyKit } from "./emergency-kit.js";

const PASSWORD = "correct horse battery";
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vapi-kit-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function setup(clock = { at: Date.parse("2026-10-27T10:00:00Z") }) {
  const secrets = memorySecretStore();
  await createVault(home, { secrets, password: PASSWORD });
  const kit = createEmergencyKit({ home, secrets, now: () => new Date(clock.at) });
  return { kit, clock, secrets };
}

describe("emergency kit", () => {
  it("reveals the words behind the password and audits without them", async () => {
    const { kit } = await setup();
    const result = await kit.reveal(PASSWORD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.words).toHaveLength(12);
    expect(() => validateRecoveryPhrase(result.words.join(" "))).not.toThrow();
    const log = await readFile(join(home, "audit.log"), "utf8");
    expect(log).toContain("secret.export.phrase");
    for (const word of result.words) expect(log).not.toContain(` ${word} `);
    expect((await readAuditLog(home)).at(-1)?.event).toBe("secret.export.phrase");
  });

  it("refuses a wrong password", async () => {
    const { kit } = await setup();
    expect(await kit.reveal("not it at all")).toMatchObject({
      ok: false,
      code: "password_required",
    });
  });

  it("waits 10 seconds between reveals", async () => {
    const { kit, clock } = await setup();
    expect((await kit.reveal(PASSWORD)).ok).toBe(true);
    clock.at += 5_000;
    expect(await kit.reveal(PASSWORD)).toMatchObject({ ok: false, code: "not_permitted" });
    clock.at += 5_000;
    expect((await kit.reveal(PASSWORD)).ok).toBe(true);
  });

  it("refuses overlapping reveals so they cannot bypass the cooldown", async () => {
    const { kit } = await setup();
    const [first, second] = await Promise.all([kit.reveal(PASSWORD), kit.reveal(PASSWORD)]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("not_permitted");
    expect(
      (await readAuditLog(home)).filter((entry) => entry.event === "secret.export.phrase"),
    ).toHaveLength(1);
  });

  it("cannot confirm when auditing prevented the words from being shown", async () => {
    const { kit } = await setup();
    await mkdir(join(home, "audit.log"));
    await expect(kit.reveal(PASSWORD)).rejects.toThrow();
    expect(await kit.confirm()).toBe(false);
    expect(await kit.done()).toBe(false);
  });

  it("confirms only after a recent reveal, and done follows this vault", async () => {
    const { kit, clock } = await setup();
    expect(await kit.confirm()).toBe(false);
    expect(await kit.done()).toBe(false);
    await kit.reveal(PASSWORD);
    clock.at += 31 * 60_000;
    expect(await kit.confirm()).toBe(false);
    clock.at += 10_000;
    await kit.reveal(PASSWORD);
    expect(await kit.confirm()).toBe(true);
    expect(await kit.done()).toBe(true);
    const stored = await readFile(join(home, "desktop-emergency-kit.json"), "utf8");
    expect(stored).not.toMatch(/\b[a-z]+ [a-z]+ [a-z]+\b/); // no words in the file
  });

  it("a new vault in the same home is not done", async () => {
    const { kit } = await setup();
    await kit.reveal(PASSWORD);
    await kit.confirm();
    await rm(join(home, "vault.json"));
    await rm(join(home, "wallets.json"), { force: true });
    const secrets = memorySecretStore();
    await createVault(home, { secrets, password: PASSWORD });
    expect(await createEmergencyKit({ home, secrets }).done()).toBe(false);
  });
});
