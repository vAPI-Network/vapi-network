/** Canonical local task verbs. Hosted signing and chain continuation use `tasks.confirm`. */
export const TASKS_CLIENT_VERBS = [
  "search",
  "show",
  "pending",
  "checkin",
  "post",
  "propose",
  "submit",
  "milestone",
  "cancel",
  "claim",
  "award",
  "sign",
  "fund",
  "deliver",
  "release",
  "refund",
  "dispute",
  "counter-evidence",
  "resolve-unmatched",
  "message",
  "thread",
  "watch",
  "status",
] as const;

export type TasksClientVerb = (typeof TASKS_CLIENT_VERBS)[number];
