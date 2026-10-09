import { keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import {
  freezeScopeTerms,
  milestoneTermsSchema,
  scopeBriefSchema,
  scopeSigningPayloadSchema,
  scopeStructuredTermsSchema,
} from "./scope-terms.js";

// Server scope-terms.test.ts fixture. The pinned hashes were computed with the server's own
// freezeScopeTerms (vapi-app 1c7ae4ad4), so a drift on either side fails here.
const structuredTerms = {
  version: "work-milestone-terms-v1" as const,
  title: "Deliver the signed API integration",
  description: "Implement and document the agreed API integration for the client.",
  deliverables: ["Production implementation", "Focused test coverage"],
  acceptanceCriteria: ["All documented examples pass"],
  revisionCount: 2,
  deadline: "2026-09-01T12:00:00.000Z",
  workDurationSeconds: 604_800,
  acceptanceWindowSeconds: 86_400,
  budget: {
    network: "eip155:84532",
    asset: "eip155:84532/erc20:0x6666666666666666666666666666666666666666",
    amountBaseUnits: "2500000",
  },
  escrow: {
    protocol: "escrow-v1" as const,
    contract: "0x4444444444444444444444444444444444444444",
  },
  evidenceRules: {
    acceptedInputs: ["text", "private-file"],
    exactCommitRequired: true,
  },
};

describe("scope terms", () => {
  it.each([
    [
      "Ship the exact signed brief.",
      "0xbcd713f65a1fd5c5e45f5e88c680cdc5c2fec50b123fc10c869b15d2cf56502a",
    ],
    ["First exact brief", "0x3c92ac62e2994e8b18e64b62e419f17236515682c836cf00f95bbb76b6b62f31"],
    ["Second exact brief", "0x49b84c24d58841a2d2111da34511bcbab2ad128ee361d05dd9c18ff74a27eff3"],
  ])("matches the server fixture hash for %s", (brief, termsHash) => {
    expect(freezeScopeTerms(structuredTerms, brief).termsHash).toBe(termsHash);
    expect(
      freezeScopeTerms(Object.fromEntries(Object.entries(structuredTerms).reverse()), brief)
        .termsHash,
    ).toBe(termsHash);
  });

  it("matches the server milestone fixture hash with its default acceptance window", () => {
    const terms = milestoneTermsSchema.parse({
      version: "work-milestone-terms-v1",
      title: "Ship the signed integration",
      description: "Implement and document the signed integration for the client.",
      acceptanceCriteria: ["The integration passes its acceptance suite"],
      budget: {
        network: "eip155:84532",
        asset: "eip155:84532/erc20:0x1111111111111111111111111111111111111111",
        amountBaseUnits: "1000000",
      },
      escrow: {
        protocol: "escrow-v1",
        contract: "0x2222222222222222222222222222222222222222",
      },
      evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: true },
    });
    expect(terms.acceptanceWindowSeconds).toBe(604_800);
    expect(terms).not.toHaveProperty("workDurationSeconds");
    expect(keccak256(toBytes(canonicalJson(terms)))).toBe(
      "0x363f8f0009685425f336238b0c1eba653a0f27086b3ee62491a5c4ad1ddcba93",
    );
  });

  it("matches the server hash for unicode, untrimmed text, defaults and an uppercase contract", () => {
    const frozen = freezeScopeTerms(
      {
        version: "work-milestone-terms-v1",
        title: "  Build a landing page  ",
        description: "  A one-page site with a contact form, ünïcødé ✓.  ",
        acceptanceCriteria: ["  Loads under 2s  ", "Has a form"],
        budget: {
          network: "eip155:8453",
          asset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amountBaseUnits: "5000000",
        },
        escrow: { protocol: "escrow-v1", contract: "0xABCDEFabcdef0000000000000000000000000001" },
        evidenceRules: { acceptedInputs: ["private-file"], exactCommitRequired: true },
        deliverables: ["  site.zip "],
        revisionCount: 0,
        deadline: "2026-11-01T12:00:00Z",
      },
      "  keep my whitespace \n\t",
    );
    expect(frozen.termsHash).toBe(
      "0xa91a5a412d5af2300df3c74be7f64430d2cd71be243a7e2fa225d14409542082",
    );
  });

  it("hashes parsed trims and defaults while preserving exact brief and asset bytes", () => {
    const asset = "eip155:84532/erc20:0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
    const frozen = freezeScopeTerms(
      {
        ...structuredTerms,
        acceptanceWindowSeconds: undefined,
        title: `  ${structuredTerms.title}  `,
        description: `\n${structuredTerms.description}\n`,
        deliverables: structuredTerms.deliverables.map((value) => ` ${value} `),
        acceptanceCriteria: structuredTerms.acceptanceCriteria.map((value) => ` ${value} `),
        budget: { ...structuredTerms.budget, asset },
        escrow: { protocol: "escrow-v1", contract: `0x${"AB".repeat(20)}` },
      },
      "  Exact brief\n",
    );
    expect(frozen.structured).toMatchObject({
      title: structuredTerms.title,
      description: structuredTerms.description,
      deliverables: structuredTerms.deliverables,
      acceptanceCriteria: structuredTerms.acceptanceCriteria,
      acceptanceWindowSeconds: 604_800,
      budget: { asset },
      escrow: { contract: `0x${"ab".repeat(20)}` },
    });
    expect(frozen.brief).toBe("  Exact brief\n");
    expect(freezeScopeTerms(frozen.structured, frozen.brief).termsHash).toBe(frozen.termsHash);
    expect(freezeScopeTerms(frozen.structured, frozen.brief.trim()).termsHash).not.toBe(
      frozen.termsHash,
    );
  });

  it("accepts canonical eip155 chain zero and rejects noncanonical networks", () => {
    expect(
      scopeStructuredTermsSchema.parse({
        ...structuredTerms,
        budget: {
          ...structuredTerms.budget,
          network: "eip155:0",
          asset: "eip155:0/erc20:0x6666666666666666666666666666666666666666",
        },
      }).budget.network,
    ).toBe("eip155:0");
    for (const network of ["eip155:084532", "eip155:00", "EIP155:84532", "eip155:-1"]) {
      expect(() =>
        scopeStructuredTermsSchema.parse({
          ...structuredTerms,
          budget: { ...structuredTerms.budget, network },
        }),
      ).toThrow();
    }
  });

  it.each([
    "USDC",
    "eip155:84532/erc20:0x1234",
    "eip155:84532/erc20:0xgggggggggggggggggggggggggggggggggggggggg",
    "eip155:84532/native:0x6666666666666666666666666666666666666666",
    "eip155:1/erc20:0x6666666666666666666666666666666666666666",
  ])("rejects a malformed or mismatched asset: %s", (asset) => {
    expect(() =>
      freezeScopeTerms(
        { ...structuredTerms, budget: { ...structuredTerms.budget, asset } },
        "Exact brief",
      ),
    ).toThrow();
  });

  it.each(["0", "01", "-1", "1.5", " 1000000"])("rejects amount %s", (amountBaseUnits) => {
    expect(() =>
      freezeScopeTerms(
        { ...structuredTerms, budget: { ...structuredTerms.budget, amountBaseUnits } },
        "Exact brief",
      ),
    ).toThrow();
  });

  it("uses the server duration boundaries and validation message", () => {
    expect(
      scopeStructuredTermsSchema.parse({ ...structuredTerms, workDurationSeconds: 600 })
        .workDurationSeconds,
    ).toBe(600);
    expect(() =>
      scopeStructuredTermsSchema.parse({ ...structuredTerms, workDurationSeconds: 599 }),
    ).toThrow("Task duration must be at least 10 minutes.");
    expect(() =>
      scopeStructuredTermsSchema.parse({ ...structuredTerms, workDurationSeconds: 7_776_001 }),
    ).toThrow();
  });

  it("rejects unknown structured fields, duplicate evidence, and invalid briefs", () => {
    expect(() => freezeScopeTerms({ ...structuredTerms, extra: true }, "Exact brief")).toThrow();
    expect(() =>
      freezeScopeTerms(
        {
          ...structuredTerms,
          evidenceRules: { acceptedInputs: ["text", "text"], exactCommitRequired: true },
        },
        "Exact brief",
      ),
    ).toThrow("Evidence inputs must be unique");
    expect(() => scopeBriefSchema.parse(" \n ")).toThrow("Scope brief is required");
    expect(() => scopeBriefSchema.parse("a".repeat(32_001))).toThrow();
  });

  it("normalizes the signing digest and rejects unknown payload fields", () => {
    const payload = {
      version: "work-scope-signature-v1",
      workOrderId: "11111111-1111-4111-8111-111111111111",
      trancheOrdinal: 1,
      scopeVersion: 1,
      termsHash: `0x${"AB".repeat(32)}`,
    };
    expect(scopeSigningPayloadSchema.parse(payload).termsHash).toBe(`0x${"ab".repeat(32)}`);
    expect(() => scopeSigningPayloadSchema.parse({ ...payload, extra: true })).toThrow();
  });
});
