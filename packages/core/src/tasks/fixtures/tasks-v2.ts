/** Recorded wire examples from vapi-app PR #468 tests and Tasks v2 deck §T32.
 * No live credentials, chain, or services are used by these fixtures.
 */
export const V2_TASK_ID = "11111111-1111-4111-8111-111111111111";
export const v2Terms = {
  shape: "task",
  checkin: "24h",
  proofSpec: { items: [{ preset: "link", mustContain: "vAPI" }], anyOf: false },
  milestones: [
    {
      index: 1,
      amountBaseUnits: "30000000",
      acceptance: "Shortlist approved",
      deadlineAt: "2026-10-11T12:00:00.000Z",
    },
    {
      index: 2,
      amountBaseUnits: "70000000",
      acceptance: "Intros completed",
      deadlineAt: "2026-10-15T12:00:00.000Z",
    },
  ],
} as const;
export const v2Lifecycle = {
  shape: "task",
  state: "Active",
  substate: "Stalled",
  milestones: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      status: "pending",
      amountBaseUnits: "30000000",
      dueAt: "2026-10-11T12:00:00.000Z",
    },
  ],
} as const;
export const v2NextAction = { action: "checkin", dueAt: "2026-10-08T11:00:00.000Z" } as const;
export const v2Pending = {
  pendingActions: [
    {
      orderId: V2_TASK_ID,
      title: "Build a page",
      role: "worker",
      action: "deliver",
      clientVerb: "deliver",
      amountBaseUnits: "30000000",
      dueAt: "2026-10-11T12:00:00.000Z",
      deepLink: `/orders/${V2_TASK_ID}`,
    },
  ],
} as const;
export const v2Checkins = {
  entries: [
    {
      status: "on-track",
      note: "Shortlist ready",
      at: "2026-10-08T12:00:00.000Z",
      byAddress: "0x1111111111111111111111111111111111111111",
    },
  ],
  nextDueAt: "2026-10-09T12:00:00.000Z",
} as const;
export const v2Events = [
  {
    type: "task.checkin",
    payload: { taskId: V2_TASK_ID, status: "on-track", note: "Shortlist ready" },
  },
  { type: "task.stalled", payload: { taskId: V2_TASK_ID, reason: "missed-checkin" } },
  { type: "task.claimed", payload: { taskId: V2_TASK_ID, submissionCount: 1 } },
  {
    type: "task.judging",
    payload: { taskId: V2_TASK_ID, submissionCount: 3, choiceDeadline: "2026-10-15T12:00:00.000Z" },
  },
  {
    type: "task.milestone",
    payload: { taskId: V2_TASK_ID, milestoneId: "22222222-2222-4222-8222-222222222222" },
  },
  {
    type: "task.released",
    payload: { taskId: V2_TASK_ID, milestoneId: "22222222-2222-4222-8222-222222222222" },
  },
] as const;
export const v2FundingUnavailable = {
  error: "funding_requires_accepted_scope",
  next: "award a worker, sign the scope, let the worker create the escrow, then call tasks.fund",
} as const;
