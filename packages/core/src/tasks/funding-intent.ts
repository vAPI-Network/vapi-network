import { isAddressEqual, type Hex, type TypedDataDomain } from "viem";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { TasksValidationError } from "./chain-error.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u)
  .refine((v) => BigInt(v) < 1n << 256n);
const intentSchema = z.object({
  kind: z.literal("eip712"),
  signer: address,
  typedData: z.object({
    domain: z.object({
      name: z.string(),
      version: z.string(),
      chainId: z.number().int(),
      verifyingContract: address,
    }),
    primaryType: z.literal("ReceiveWithAuthorization"),
    types: z.unknown(),
    message: z.strictObject({
      from: address,
      to: address,
      value: uint,
      validAfter: uint,
      validBefore: uint,
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
    }),
  }),
});
/** Accept a hosted nonce only after all signing fields match locally verified terms. */
export function taskFundingIntentNonce(
  intent: unknown,
  expected: {
    domain: TypedDataDomain;
    types: unknown;
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
    validBefore: bigint;
  },
): Hex {
  const parsed = intentSchema.safeParse(intent);
  if (!parsed.success) throw new TasksValidationError("Invalid task funding intent.");
  const {
    signer,
    typedData: { domain, types, message },
  } = parsed.data;
  if (
    !isAddressEqual(signer as Hex, expected.from) ||
    !isAddressEqual(message.from as Hex, expected.from) ||
    !isAddressEqual(message.to as Hex, expected.to) ||
    message.value !== expected.value.toString() ||
    message.validAfter !== "0" ||
    message.validBefore !== expected.validBefore.toString() ||
    domain.name !== expected.domain.name ||
    domain.version !== expected.domain.version ||
    domain.chainId !== expected.domain.chainId ||
    !isAddressEqual(domain.verifyingContract as Hex, expected.domain.verifyingContract!) ||
    canonicalJson(types) !== canonicalJson(expected.types)
  )
    throw new TasksValidationError(
      "The task funding intent does not match the verified escrow, amount, signer, token domain or deadline.",
    );
  return message.nonce.toLowerCase() as Hex;
}
