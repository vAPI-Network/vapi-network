// SPDX-License-Identifier: Apache-2.0
// Tasks V2 contract ABIs. The entries are copied verbatim from the vapi-app generated artifact
// by scripts/sync-tasks-v2-abi.mjs into v2-abi.generated.ts; never write an entry by hand.
// Read-only calls and decoding only: never use these to build participant calldata.
export {
  escrowFactoryV2Abi,
  escrowV2Abi,
  bountyEscrowV2Abi,
  disputeResolverV3Abi,
  bountyPoolFactoryV1Abi,
  bountyPoolV1Abi,
} from "./v2-abi.generated.js";

/** DisputeResolverV3 CaseState (vapi-app tasks-v2.ts). Snapshotting was appended onchain. */
export const TASK_V2_CASE_STATE = {
  None: 0,
  Raised: 1,
  Matched: 2,
  JuryDrawPending: 3,
  Voting: 4,
  Resolved: 5,
  Snapshotting: 6,
} as const;
