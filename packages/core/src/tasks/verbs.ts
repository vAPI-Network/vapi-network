/**
 * Canonical task client verbs. docs/tasks.md carries the same table. Plan 032
 * Lane B8 will copy this list to the vapi-app docs/PUBLIC-API.md reference.
 */
export const TASKS_CLIENT_VERBS = [
  "search",
  "show",
  "post",
  "propose",
  "submit",
  "award",
  "sign",
  "fund",
  "deliver",
  "release",
  "refund",
  "dispute",
  "message",
  "thread",
  "watch",
  "status",
] as const;

export type TasksClientVerb = (typeof TASKS_CLIENT_VERBS)[number];
