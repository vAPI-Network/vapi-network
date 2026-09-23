import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listAgentProfiles,
  readAgentProfile,
  removeAgentProfile,
  writeAgentProfile,
  type AgentProfileInput,
} from "./agent-profile.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryHome(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "home");
}

function profile(overrides: Partial<AgentProfileInput> = {}): AgentProfileInput {
  return {
    version: 1,
    name: "researcher",
    wallet: "researcher",
    model: "openai/gpt-5",
    instructions: "Research carefully and cite sources.",
    createdAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("agent profiles", () => {
  it("round trips a profile", async () => {
    const home = await temporaryHome("vapi-agent-profile-round-trip-");
    const expected: AgentProfileInput = {
      ...profile(),
      verifiedOnly: false,
      approveAboveUsd: 0.25,
      maxSteps: 6,
      tools: ["call.search", "call.pay"],
      paused: true,
    };

    await writeAgentProfile(home, expected);

    await expect(readAgentProfile(home, "researcher")).resolves.toEqual(expected);
  });

  it("applies defaults when optional fields are omitted", async () => {
    const home = await temporaryHome("vapi-agent-profile-defaults-");

    await writeAgentProfile(home, profile());

    await expect(readAgentProfile(home, "researcher")).resolves.toMatchObject({
      verifiedOnly: true,
      approveAboveUsd: 0.5,
      maxSteps: 12,
      tools: ["call.search", "call.inspect", "call.pay"],
      paused: false,
    });
  });

  it.each(["Bad Name", "../x", "a".repeat(33)])("rejects the bad name %j", async (name) => {
    const home = await temporaryHome("vapi-agent-profile-bad-name-");

    await expect(writeAgentProfile(home, profile({ name }))).rejects.toThrow();
    await expect(readAgentProfile(home, name)).rejects.toThrow();
  });

  it("writes profile files with mode 0600", async () => {
    const home = await temporaryHome("vapi-agent-profile-mode-");

    await writeAgentProfile(home, profile());

    expect((await stat(join(home, "agents", "researcher.json"))).mode & 0o777).toBe(0o600);
  });

  it("lists profiles by name and warns while skipping an unparsable file", async () => {
    const home = await temporaryHome("vapi-agent-profile-list-");
    const agentsDirectory = join(home, "agents");
    const warn = vi.fn();
    await writeAgentProfile(home, profile({ name: "zeta", wallet: "zeta" }));
    await writeAgentProfile(home, profile({ name: "alpha", wallet: "alpha" }));
    await mkdir(agentsDirectory, { recursive: true });
    await writeFile(join(agentsDirectory, "broken.json"), "{not json", "utf8");

    const profiles = await listAgentProfiles(home, { warn });

    expect(profiles.map(({ name }) => name)).toEqual(["alpha", "zeta"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("broken.json");
  });

  it("returns an empty list when the agents directory is missing", async () => {
    await expect(
      listAgentProfiles(await temporaryHome("vapi-agent-profile-missing-list-")),
    ).resolves.toEqual([]);
  });

  it("removes a profile and then reports the documented not-found message", async () => {
    const home = await temporaryHome("vapi-agent-profile-remove-");
    await writeAgentProfile(home, profile());

    await removeAgentProfile(home, "researcher");
    await removeAgentProfile(home, "researcher");

    await expect(readAgentProfile(home, "researcher")).rejects.toThrow(
      "No agent named researcher. Create it with vapi agent create researcher.",
    );
  });
});
