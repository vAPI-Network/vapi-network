import { keccak256, stringToHex, toHex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import { verifyClone, verifyScope, type VerifiedContext } from "./chain-verification.js";
import type { TasksClient } from "./client.js";
import type { TaskMilestone } from "./chain-port.js";
import { freezeScopeTerms } from "./scope-terms.js";
import type { DeploymentResponse } from "./types.js";

const self = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const attacker = privateKeyToAccount(`0x${"33".repeat(32)}`);
const orderId = "11111111-1111-4111-8111-111111111111";
const milestoneId = "22222222-2222-4222-8222-222222222222";
const factory = "0x6Ba83621eb386B3E093032096251cA504F6ee033" as const;
const token = "0x4444444444444444444444444444444444444444" as const;
const clone = "0x5555555555555555555555555555555555555555" as const;
const ready = {
  configured: true,
  chainId: 84532,
  network: "eip155:84532",
  escrowContract: factory,
  usdc: token,
  defaults: { workDurationSeconds: 1 },
} as unknown as Extract<DeploymentResponse, { configured: true }>;
const structured = {
  version: "work-milestone-terms-v1",
  title: "Write a report",
  description: "Write a complete report.",
  deliverables: ["The report"],
  revisionCount: 0,
  deadline: "2026-10-08T12:00:00.000Z",
  acceptanceCriteria: ["Report complete"],
  acceptanceWindowSeconds: 3600,
  budget: {
    network: ready.network,
    asset: `${ready.network}/erc20:${token}`,
    amountBaseUnits: "100000000",
  },
  escrow: { protocol: "escrow-v1", contract: factory },
  evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: false },
};
const frozen = freezeScopeTerms(structured, "Report brief");
const payload = {
  version: "work-scope-signature-v1",
  workOrderId: orderId,
  trancheOrdinal: 1,
  scopeVersion: 1,
  termsHash: frozen.termsHash,
};
const milestone = {
  id: milestoneId,
  workOrderId: orderId,
  ordinal: 1,
  terms: frozen.structured,
  termsHash: frozen.termsHash,
  network: ready.network,
  asset: structured.budget.asset,
  amountBaseUnits: "100000000",
  escrowContract: clone,
} as unknown as TaskMilestone;
const binding = {
  orderId,
  trancheOrdinal: 1,
  scopeVersion: 1,
  termsHash: frozen.termsHash,
  role: "client" as const,
  self: self.address,
  counterparty: other.address,
  signedAt: "2026-10-08T12:00:00.000Z",
};
async function setup(counterparty = other) {
  const message = canonicalJson(payload);
  const scope = {
    workOrderId: orderId,
    trancheOrdinal: 1,
    version: 1,
    state: "accepted",
    milestoneId,
    structuredTerms: structured,
    brief: "Report brief",
    termsHash: frozen.termsHash,
    signingPayload: payload,
    proposerAddress: counterparty.address,
    proposerSignature: await counterparty.signMessage({ message }),
    counterpartyAddress: self.address,
    counterpartySignature: await self.signMessage({ message }),
  };
  const client = {
    getScopes: vi.fn().mockResolvedValue({ scopes: [scope] }),
  } as unknown as TasksClient;
  const bindings = {
    get: vi.fn().mockResolvedValue(binding),
    put: vi.fn().mockResolvedValue(undefined),
  };
  return { client, bindings };
}
function scopeVerification(client: TasksClient, options: unknown = {}) {
  return (verifyScope as (...args: unknown[]) => Promise<VerifiedContext>)(
    client,
    self.address,
    milestone,
    ready,
    "fund",
    ["deposit-funds"],
    options,
  );
}
function context(): VerifiedContext {
  return {
    signer: self.address,
    buyer: self.address,
    seller: other.address,
    parties: [self.address, other.address],
    verb: "fund",
    deployment: ready,
    milestone,
    steps: ["deposit-funds"],
    workDurationSeconds: 604800,
    reviewWindowSeconds: 3600,
  } as VerifiedContext;
}
function word(fields: [bigint, number][]): `0x${string}` {
  return toHex(
    fields.reduce((v, [n, offset]) => v | (n << BigInt(offset * 8)), 0n),
    { size: 32 },
  );
}
function rpcFixture(
  values: Partial<Record<string, unknown>> = {},
  storage: Partial<Record<string, `0x${string}`>> = {},
) {
  const defaults: Record<string, unknown> = {
    isEscrow: true,
    buyer: self.address,
    seller: other.address,
    token,
    amount: 100000000n,
    termsHash: frozen.termsHash,
    state: 1,
    resolution: 0,
    offerDeadline: 2000000000n,
    workDeadline: 0n,
    reviewDeadline: 0n,
    disputedAt: 0n,
    counterEvidenceDeadline: 0n,
    predictEscrow: clone,
    disputeFee: 20000000n,
  };
  const slots: Record<string, `0x${string}`> = {
    "0x0": word([
      [1n, 0],
      [BigInt(self.address), 2],
    ]),
    "0x6": word([[2000000000n, 0]]),
    "0x7": word([
      [604800n, 8],
      [3600n, 16],
    ]),
    "0x8": word([[BigInt(other.address), 0]]),
  };
  return {
    readContract: vi.fn(
      async ({ functionName }: { functionName: string }) =>
        ({ ...defaults, ...values })[functionName],
    ),
    getStorageAt: vi.fn(async ({ slot }: { slot: string }) => ({ ...slots, ...storage })[slot]),
  } as unknown as PublicClient;
}

describe("locally bound scope parties", () => {
  it("refuses a scope with no local party binding before a money signature", async () => {
    const { client } = await setup();
    await expect(scopeVerification(client)).rejects.toThrow(
      "The task parties are not bound on this machine. Re-run with --counterparty <address> to confirm who you are working with.",
    );
  });
  it("refuses an attacker-signed scope paired with the local signature", async () => {
    const { client, bindings } = await setup(attacker);
    await expect(scopeVerification(client, { bindings })).rejects.toThrow(/bound parties/);
  });
  it("derives buyer and seller from the durable binding role", async () => {
    const { client, bindings } = await setup();
    expect(await scopeVerification(client, { bindings })).toMatchObject({
      buyer: self.address,
      seller: other.address,
    });
  });
  it("verifies explicit counterparty signatures and records the binding", async () => {
    const { client, bindings } = await setup();
    bindings.get.mockResolvedValue(undefined);
    await scopeVerification(client, {
      bindings,
      counterparty: other.address,
      rpc: rpcFixture(),
      now: () => new Date(binding.signedAt),
    });
    expect(bindings.put).toHaveBeenCalledWith(binding);
  });
  it("refuses explicit counterparty confirmation that did not sign the scope", async () => {
    const { client, bindings } = await setup();
    bindings.get.mockResolvedValue(undefined);
    await expect(
      scopeVerification(client, { bindings, counterparty: attacker.address, rpc: rpcFixture() }),
    ).rejects.toThrow(/counterparty.*signature/);
    expect(bindings.put).not.toHaveBeenCalled();
  });
  it("refuses a clone whose buyer and seller swap the locally bound roles", async () => {
    await expect(
      verifyClone(rpcFixture({ buyer: other.address, seller: self.address }), context(), false),
    ).rejects.toThrow(/parties/);
  });
});

describe("signed clone salt and durations", () => {
  it("refuses a registered clone with a one-second review window", async () => {
    await expect(
      verifyClone(
        rpcFixture(
          {},
          {
            "0x7": word([
              [604800n, 8],
              [1n, 16],
            ]),
          },
        ),
        context(),
        false,
      ),
    ).rejects.toThrow(/durations/);
  });
  it("refuses a registered clone at the wrong milestone salt", async () => {
    const rpc = rpcFixture({ predictEscrow: attacker.address });
    await expect(verifyClone(rpc, context(), false)).rejects.toThrow(/salt/);
    expect(rpc.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: factory,
        functionName: "predictEscrow",
        args: [other.address, keccak256(stringToHex(milestoneId))],
      }),
    );
  });
  it("refuses an unsupported escrow storage layout", async () => {
    await expect(
      verifyClone(rpcFixture({}, { "0x6": word([[1n, 0]]) }), context(), false),
    ).rejects.toThrow("unsupported escrow layout");
  });
  it("accepts a clone with pinned work duration and the signed review window", async () => {
    await expect(verifyClone(rpcFixture(), context(), false)).resolves.toBeUndefined();
  });
});

describe("local dispute eligibility", () => {
  const counterDeadline = 1900000000n;
  function disputed(opener = other.address, submitted = false) {
    return rpcFixture(
      { state: 4, counterEvidenceDeadline: counterDeadline },
      {
        "0x0": word([
          [4n, 0],
          [BigInt(self.address), 2],
        ]),
        "0x7": word([
          [counterDeadline, 0],
          [604800n, 8],
          [3600n, 16],
        ]),
        "0x8": word([
          [BigInt(opener), 0],
          [submitted ? 1n : 0n, 20],
        ]),
      },
    );
  }
  it("refuses counter-evidence by the dispute opener", async () => {
    await expect(
      verifyClone(
        disputed(self.address),
        { ...context(), verb: "counter-evidence", nowSeconds: counterDeadline - 1n },
        true,
      ),
    ).rejects.toThrow("Only the non-opener party can submit counter-evidence.");
  });
  it("refuses counter-evidence at or after the deadline", async () => {
    await expect(
      verifyClone(
        disputed(),
        { ...context(), verb: "counter-evidence", nowSeconds: counterDeadline },
        true,
      ),
    ).rejects.toThrow("The counter-evidence deadline has passed.");
  });
  it("refuses unmatched resolution before or at the deadline", async () => {
    await expect(
      verifyClone(
        disputed(),
        { ...context(), verb: "resolve-unmatched", nowSeconds: counterDeadline },
        true,
      ),
    ).rejects.toThrow(/deadline has not passed/);
  });
  it("refuses unmatched resolution when counter-evidence was submitted", async () => {
    await expect(
      verifyClone(
        disputed(other.address, true),
        { ...context(), verb: "resolve-unmatched", nowSeconds: counterDeadline + 1n },
        true,
      ),
    ).rejects.toThrow(/already been submitted/);
  });
  it("accepts eligible counter-evidence with the verified fee", async () => {
    const expected: VerifiedContext = {
      ...context(),
      verb: "counter-evidence",
      nowSeconds: counterDeadline - 1n,
    };
    await verifyClone(disputed(), expected, true);
    expect(expected.disputeFee).toBe(20000000n);
    expect(expected.approveAmount).toBe(20000000n);
  });
  it("accepts unmatched resolution only after the deadline", async () => {
    await expect(
      verifyClone(
        disputed(),
        { ...context(), verb: "resolve-unmatched", nowSeconds: counterDeadline + 1n },
        true,
      ),
    ).resolves.toBeUndefined();
  });
  it("refuses an unsupported dispute opener storage layout", async () => {
    await expect(
      verifyClone(
        disputed(attacker.address),
        { ...context(), verb: "resolve-unmatched", nowSeconds: counterDeadline + 1n },
        true,
      ),
    ).rejects.toThrow("unsupported escrow layout");
  });
  it("keeps immutable checks while resuming after deadline eligibility changed", async () => {
    await expect(
      verifyClone(
        disputed(self.address, true),
        { ...context(), verb: "counter-evidence", nowSeconds: counterDeadline + 1n },
        false,
      ),
    ).resolves.toBeUndefined();
  });
  it("refuses a fee differing from the locally computed amount rule", async () => {
    await expect(
      verifyClone(rpcFixture({ disputeFee: 1n }), { ...context(), verb: "dispute" }, false),
    ).rejects.toThrow(/dispute fee does not match/);
  });
});
