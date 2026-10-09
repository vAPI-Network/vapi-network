import { expect, it } from "vitest";
import { configSchema, getDefaultConfig } from "../config.js";

it("loads trusted Tasks duration overrides from local environment", () => {
  expect(
    getDefaultConfig({
      VAPI_TASKS_WORK_DURATION_SECONDS_84532: "3600",
      VAPI_TASKS_REVIEW_WINDOW_SECONDS_84532: "600",
    }),
  ).toMatchObject({
    tasksEscrowDurationOverrides: {
      "84532": { workDurationSeconds: 3600, reviewWindowSeconds: 600 },
    },
  });
});
it("rejects invalid local Tasks duration overrides", () => {
  expect(() => getDefaultConfig({ VAPI_TASKS_WORK_DURATION_SECONDS_84532: "0" })).toThrow();
  expect(() =>
    configSchema.parse({
      ...getDefaultConfig({}),
      tasksEscrowDurationOverrides: { "84532": { workDurationSeconds: -1 } },
    }),
  ).toThrow();
});
