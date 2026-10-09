import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { z } from "zod";

import { withFileLock, writeJsonAtomic } from "../atomic-file.js";
import { TasksValidationError } from "./chain-error.js";

export type ScopeBindingIdentity = {
  orderId: string;
  trancheOrdinal: number;
  scopeVersion: number;
  termsHash: Hex;
  self: Address;
};
export type ScopeBinding = ScopeBindingIdentity & {
  role: "client" | "provider";
  counterparty: Address;
  signedAt: string;
};
export interface ScopeBindings {
  get(identity: ScopeBindingIdentity): Promise<ScopeBinding | undefined>;
  put(binding: ScopeBinding): Promise<void>;
}
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => getAddress(value));
const bindingSchema = z
  .object({
    orderId: z.uuid(),
    trancheOrdinal: z.number().int().positive(),
    scopeVersion: z.number().int().positive(),
    termsHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((v) => v.toLowerCase() as Hex),
    self: address,
    counterparty: address,
    role: z.enum(["client", "provider"]),
    signedAt: z.iso.datetime(),
  })
  .strict()
  .refine((value) => !isAddressEqual(value.self, value.counterparty));
const storeSchema = z
  .object({ version: z.literal(1), bindings: z.record(z.string(), bindingSchema) })
  .strict();
function key(identity: ScopeBindingIdentity): string {
  return `${identity.orderId}:${identity.trancheOrdinal}:${identity.scopeVersion}:${identity.termsHash.toLowerCase()}:${identity.self.toLowerCase()}`;
}

/** Party consent is local state: scope v1 itself does not sign the party addresses. */
export function createScopeBindings(home: string): ScopeBindings {
  const path = join(home, "tasks", "scope-bindings.json");
  async function read() {
    try {
      return storeSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { version: 1 as const, bindings: {} as Record<string, ScopeBinding> };
      throw new TasksValidationError("The local task party bindings could not be read.", {
        cause: error,
      });
    }
  }
  return {
    async get(identity) {
      return (await read()).bindings[key(identity)];
    },
    async put(input) {
      const binding = bindingSchema.parse(input);
      await withFileLock(`${path}.lock`, async () => {
        const state = await read();
        const existing = state.bindings[key(binding)];
        if (
          existing &&
          (existing.role !== binding.role ||
            !isAddressEqual(existing.counterparty, binding.counterparty))
        )
          throw new TasksValidationError(
            "The confirmed task parties differ from the existing local binding.",
          );
        state.bindings[key(binding)] = existing ?? binding;
        await writeJsonAtomic(path, state);
      });
    },
  };
}
