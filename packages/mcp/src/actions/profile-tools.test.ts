import { createAgentProfileSchema } from "@vapi-network/core";
import { describe, expect, it } from "vitest";

import { z } from "zod";

import { defineAction } from "./define.js";
import { actions, agentToolNames, registeredAgentProfileSchema } from "./register.js";

describe("agent profile tools", () => {
  it("takes product validation and defaults from the action register", () => {
    const profile = registeredAgentProfileSchema.parse({
      version: 1,
      name: "researcher",
      wallet: "researcher",
      model: "router/test",
      instructions: "Research carefully.",
      createdAt: "2026-09-29T00:00:00.000Z",
    });

    expect(agentToolNames).toEqual(
      actions.filter((action) => action.grant === "call").map((action) => action.name),
    );
    expect(profile.tools).toEqual(agentToolNames);
  });

  it("accepts a newly registered call action without a core enum change", () => {
    const future = defineAction({
      name: "call.future",
      description: "Future call action.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      money: "none",
      grant: "call",
      async run() {
        return { ok: true };
      },
    });
    const names = [...actions, future]
      .filter((action) => action.grant === "call")
      .map((action) => action.name);
    const schema = createAgentProfileSchema(names);

    const profile = schema.parse({
      version: 1,
      name: "researcher",
      wallet: "researcher",
      model: "router/test",
      instructions: "Research carefully.",
      createdAt: "2026-09-29T00:00:00.000Z",
    });

    expect(profile.tools).toEqual(names);
    expect(() => registeredAgentProfileSchema.parse(profile)).toThrow();
  });
});
