import { describe, expect, it } from "vitest";
import { z } from "zod";

import { inspectToolResultSchema } from "./call.js";

const inspected = {
  name: "email_count",
  method: "POST",
  url: "https://mpp.example/email-count",
  price: "$0.01",
  description: "Count matching emails.",
  verification: "none",
};

describe("call action result contracts", () => {
  it("exports inspect output as JSON Schema for MCP registration", () => {
    expect(() => z.toJSONSchema(inspectToolResultSchema)).not.toThrow();
  });

  it.each([
    {
      protocol: "mpp",
      intent: "charge",
      method: "tempo",
      checkedAt: "2026-08-19T10:30:00.000Z",
    },
    {
      protocol: "future-pay",
      intent: "future-intent",
      method: { display: "future method" },
      checkedAt: "2026-08-19T10:30:00.000Z",
    },
  ])("parses inspect output carrying $protocol metadata", (payment) => {
    expect(inspectToolResultSchema.parse({ ...inspected, payment })).toMatchObject({ payment });
  });
});
