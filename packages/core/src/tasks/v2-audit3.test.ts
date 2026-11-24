// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  zeroHash,
  type Hex,
  type Abi,
} from "viem";
import {
  TASKS_V2_EVENT_ABIS,
  decodeTaskV2Event,
  normalizeTaskV2Outcomes,
  taskV2OutcomeLines,
  TASK_V2_NO_VERDICT_SUMMARY,
  TASK_V2_REVIEWER_GUIDANCE,
  TASK_V2_JURY_RULES,
} from "./v2-events.js";
import { disputeResolverV3Abi, escrowV2Abi } from "./v2-abi.js";
import { taskEventLine } from "./operation-support.js";
import { taskV2ActionSchema } from "./v2-write.js";
import { publicTaskLifecycle, redactTaskV2Ballots } from "./v2-public.js";

// SHA-256 of JSON.stringify(ABI) from the audited contract JSON at fcc670908.
// This checks all constructors, errors, functions, events, tuple fields and integer widths.
const auditedHashes = {
  EscrowFactoryV2: "b0ce4288d3e7da0e54510b533b9b39fdc8fc563da809dbc91fb47e2207d74084",
  EscrowV2: "6d571f1924519286682a75b311755a53d7df94f194b26355ae80575efb1cb4b6",
  BountyEscrowV2: "e4f6acaa181ae78a7056abb47aeebdb6ac60d800ec04c96ac77bb463b7e71f45",
  DisputeResolverV3: "abc00c8070e86150b586c203cb37e03d4f02acbea24056011bd5cce03cdf10ce",
  BountyPoolFactoryV1: "00a2537e2f7275d7a4a8b5807f9f45686203216f1f294486b627be07a1100cab",
  BountyPoolV1: "6a980f665377270b3d9775c98dd77293152bd1f6af15ce62386a69e9a3809e39",
  ReviewerRegistryV2: "f1935666689f8721cf02b8f6f4529aa47f2dcad7fc245a057600e8c0e825896c",
  OutcomeRegistryV1: "771fd014cf3edaf6d4218e2de4b105ed799ae2a0e214e8f1535b4a280a97aa46",
  FeeRouterV1: "1014ab66bdc3378abbb24d916df00d1797cdb84444ae0403c887f54cc9cffbf7",
} as const;

describe("audit-3 ABI provenance", () => {
  it.each(Object.entries(auditedHashes))("copies the complete %s ABI", (contract, sha) => {
    const abi = TASKS_V2_EVENT_ABIS[contract as keyof typeof TASKS_V2_EVENT_ABIS];
    expect(createHash("sha256").update(JSON.stringify(abi)).digest("hex")).toBe(sha);
  });
  it("drops the removed objection-window getter", () => {
    expect(
      escrowV2Abi.some((entry) => "name" in entry && String(entry.name) === "MIN_OBJECTION_WINDOW"),
    ).toBe(false);
  });
  it("decodes rearms in the audited caseData tuple without shifting vote counts or reviewers", () => {
    const abi = parseAbi([
      "function caseData(address,uint8) view returns ((uint8 state,uint8 juryMode,address raisedBy,uint64 raisedAt,uint64 evidenceDeadline,uint64 commitDeadline,uint64 revealDeadline,uint64 drawBlock,uint8 revealCount,uint8 committedCount,uint32 eligiblePoolSize,uint32 round,bool noQuorum,uint32 snapshotRemaining,uint8 rearms,uint8[3] voteCounts,address[5] reviewers))",
    ]);
    const data = {
      state: 3,
      juryMode: 1,
      raisedBy: zeroAddress,
      raisedAt: 10n,
      evidenceDeadline: 20n,
      commitDeadline: 30n,
      revealDeadline: 40n,
      drawBlock: 100n,
      revealCount: 0,
      committedCount: 0,
      eligiblePoolSize: 30,
      round: 1,
      noQuorum: false,
      snapshotRemaining: 0,
      rearms: 3,
      voteCounts: [1, 2, 3],
      reviewers: Array(5).fill(zeroAddress),
    };
    const encoded = encodeFunctionResult({ abi, functionName: "caseData", result: data as never });
    expect(
      decodeFunctionResult({ abi: disputeResolverV3Abi, functionName: "caseData", data: encoded }),
    ).toMatchObject({ rearms: 3, voteCounts: [1, 2, 3], reviewers: Array(5).fill(zeroAddress) });
  });
});

// Encode with independent Solidity event signatures, then decode with the synced artifact.
const signer = `0x${"12".repeat(20)}` as Hex;
const eventVectors = [
  {
    contract: "EscrowV2",
    signature:
      "event DisputeFeesSettled(uint8 indexed i,uint32 round,uint96 toPoster,uint96 toWorker,uint96 toReviewers)",
    eventName: "DisputeFeesSettled",
    indexed: { i: 2 },
    types: "uint32,uint96,uint96,uint96",
    values: [1, 10n, 20n, 30n],
    expected: { i: 2, round: 1, toPoster: 10n, toWorker: 20n, toReviewers: 30n },
  },
  {
    contract: "EscrowV2",
    signature: "event ConsentNonceBumped(address indexed signer,uint256 nonce)",
    eventName: "ConsentNonceBumped",
    indexed: { signer },
    types: "uint256",
    values: [9n],
    expected: { signer, nonce: 9n },
  },
  {
    contract: "DisputeResolverV3",
    signature:
      "event RoundEndedWithoutJury(address indexed escrow,uint8 indexed milestone,uint32 round,uint8 reason)",
    eventName: "RoundEndedWithoutJury",
    indexed: { escrow: signer, milestone: 2 },
    types: "uint32,uint8",
    values: [1, 2],
    expected: { escrow: signer, milestone: 2, round: 1, reason: 2 },
  },
  {
    contract: "ReviewerRegistryV2",
    signature: "event ReviewerPruned(address indexed reviewer)",
    eventName: "ReviewerPruned",
    indexed: { reviewer: signer },
    types: "",
    values: [],
    expected: { reviewer: signer },
  },
  ...(["BountyPoolV1", "DisputeResolverV3"] as const).map((contract) => ({
    contract,
    signature: "event SurplusSwept(uint256 amount)",
    eventName: "SurplusSwept",
    indexed: {},
    types: "uint256",
    values: [99n],
    expected: { amount: 99n },
  })),
];
describe("audit-3 log decoding", () => {
  it.each(eventVectors)("decodes $contract.$eventName", (vector) => {
    const topics = encodeEventTopics({
      abi: parseAbi([vector.signature]) as Abi,
      eventName: vector.eventName,
      args: vector.indexed,
    });
    const data = vector.types
      ? encodeAbiParameters(parseAbiParameters(vector.types), vector.values)
      : "0x";
    expect(
      decodeTaskV2Event(vector.contract as keyof typeof TASKS_V2_EVENT_ABIS, {
        topics: topics as [Hex, ...Hex[]],
        data,
      }),
    ).toMatchObject({ eventName: vector.eventName, args: vector.expected });
  });
  it("rejects malformed logs", () => {
    expect(() => decodeTaskV2Event("EscrowV2", { data: "0x", topics: [zeroHash] })).toThrow();
  });
});

describe("audit-3 public semantics", () => {
  it("includes the cause-6 explanation in event summaries", () => {
    expect(taskEventLine({ sequence: 1, type: "task.released", payload: { cause: 6 } })).toContain(
      TASK_V2_NO_VERDICT_SUMMARY,
    );
  });
  it.each([6, "6", 6n])(
    "labels cause %s as disputed without a winner, preserving payout amounts",
    (cause) => {
      const value = { cause, paidToWorker: "100", disputed: false, disputeWinner: 1 };
      expect(normalizeTaskV2Outcomes(value)).toMatchObject({
        disputed: true,
        disputeWinner: 0,
        paidToWorker: "100",
        summary: TASK_V2_NO_VERDICT_SUMMARY,
      });
      expect(taskV2OutcomeLines({ workOrder: { v2State: { outcomes: [value] } } })).toEqual([
        TASK_V2_NO_VERDICT_SUMMARY,
      ]);
      expect(redactTaskV2Ballots({ chainState: { outcomes: [value] } })).toMatchObject({
        chainState: {
          outcomes: [{ disputed: true, disputeWinner: 0, summary: TASK_V2_NO_VERDICT_SUMMARY }],
        },
      });
    },
  );
  it("decodes the cause-6 Outcome event as disputed with no winner", () => {
    const abi = parseAbi([
      "event Outcome(bytes32 indexed outcomeId,address indexed escrow,uint8 milestone,address indexed poster,address worker,uint8 shape,uint96 gross,uint96 paidToWorker,uint96 refundedToPoster,uint8 cause,bool disputed,uint8 disputeWinner)",
    ]);
    const topics = encodeEventTopics({
      abi,
      eventName: "Outcome",
      args: { outcomeId: zeroHash, escrow: signer, poster: signer },
    });
    const data = encodeAbiParameters(
      parseAbiParameters("uint8,address,uint8,uint96,uint96,uint96,uint8,bool,uint8"),
      [0, signer, 0, 100n, 100n, 0n, 6, true, 0],
    );
    expect(
      decodeTaskV2Event("OutcomeRegistryV1", { topics: topics as [Hex, ...Hex[]], data }),
    ).toMatchObject({
      args: { cause: 6, disputed: true, disputeWinner: 0, summary: TASK_V2_NO_VERDICT_SUMMARY },
    });
  });
  it("describes mayVote as membership only and warns against even a cancelled unstake", () => {
    expect(normalizeTaskV2Outcomes({ mayVote: true })).toMatchObject({
      juryMember: true,
      mayVoteMeaning: "jury membership only",
      reviewerGuidance: TASK_V2_REVIEWER_GUIDANCE,
    });
    expect(TASK_V2_REVIEWER_GUIDANCE).toContain("Do not touch your stake until you have revealed");
    expect(TASK_V2_REVIEWER_GUIDANCE).toContain("even a cancelled unstake can cost the vote");
    expect(TASK_V2_JURY_RULES).toContain("Round 2 without a verdict");
    expect(TASK_V2_JURY_RULES).toContain("8,191");
  });
  it.each(["abc", "", "1.5", "-1", "01", (2n ** 128n).toString()])(
    "rejects out-of-range nonce input %s",
    (newNonce) => {
      expect(taskV2ActionSchema.safeParse({ action: "bump-consent-nonce", newNonce }).success).toBe(
        false,
      );
    },
  );
  it("preserves cause-6 explanation in lifecycle summaries", () => {
    expect(
      publicTaskLifecycle({
        shape: "task",
        state: "Settled",
        milestones: [{ id: "0", status: "released", amountBaseUnits: "100", cause: 6 }],
      }),
    ).toMatchObject({
      milestones: [
        { cause: 6, disputed: true, disputeWinner: 0, summary: TASK_V2_NO_VERDICT_SUMMARY },
      ],
    });
  });
});
