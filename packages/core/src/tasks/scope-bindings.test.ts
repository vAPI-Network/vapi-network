import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createScopeBindings, type ScopeBinding } from "./scope-bindings.js";

const directories: string[] = [];
const binding: ScopeBinding = {
  orderId: "11111111-1111-4111-8111-111111111111",
  trancheOrdinal: 1,
  scopeVersion: 1,
  termsHash: `0x${"ab".repeat(32)}`,
  role: "client",
  self: "0x1111111111111111111111111111111111111111",
  counterparty: "0x2222222222222222222222222222222222222222",
  signedAt: "2026-10-08T12:00:00.000Z",
};
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "vapi-task-bindings-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("persists a party binding durably in a private tasks file", async () => {
  const directory = await home();
  const bindings = createScopeBindings(directory);
  expect(await bindings.get(binding)).toBeUndefined();
  await bindings.put(binding);
  expect(await createScopeBindings(directory).get(binding)).toEqual(binding);
  const path = join(directory, "tasks", "scope-bindings.json");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
});

it("serializes concurrent scope bindings without dropping a tranche", async () => {
  const directory = await home();
  const variants = Array.from({ length: 5 }, (_, i) => ({ ...binding, trancheOrdinal: i + 1 }));
  await Promise.all(variants.map((value) => createScopeBindings(directory).put(value)));
  for (const value of variants)
    expect(await createScopeBindings(directory).get(value)).toEqual(value);
});

it("refuses to rewrite signed consent with different parties or roles", async () => {
  const directory = await home();
  const bindings = createScopeBindings(directory);
  await bindings.put(binding);
  await expect(bindings.put({ ...binding, role: "provider" })).rejects.toThrow(
    /existing local binding/,
  );
  await expect(
    bindings.put({ ...binding, counterparty: "0x3333333333333333333333333333333333333333" }),
  ).rejects.toThrow(/existing local binding/);
  expect(await bindings.get(binding)).toEqual(binding);
});
