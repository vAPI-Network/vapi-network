import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateFromTreasury,
  appendReceipt,
  BASE_MAINNET_CAIP2,
  createAgentProfileSchema,
  getDefaultConfig,
  getVapiPaths,
  readDelegationRecord,
  readAgentProfile,
  readMovement,
  readReceipts,
  setupSwarm,
  treasuryRequestMovementId,
  WalletStore,
  withSwarmLock,
  writeDelegationRecord,
  writeSwarm,
  type ChatRequest,
  type ChatResult,
  type DeviceLinkStart,
  type MarketplaceDiscoveryPage,
  type MarketplaceHit,
  type RunBudget,
  type SecretStore,
  type SwarmCapitalDeps,
  type SwarmFile,
  type SwarmStatusResult,
  type TransferArgs,
  type TransferNetwork,
  type TransferResult,
} from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createAgentRunDeps } from "./deps.js";
import { runSwarm, type MemberRunOptions, type RunSwarmDeps } from "./swarm-run.js";
import type { RunAgentDeps, RunAgentResult, SwarmRunContext } from "./run.js";

const NOW = Date.parse("2026-09-30T10:00:00.000Z");
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const API_BASE = "https://api.vapinetwork.ai";
const PHRASE = "test test test test test test test test test test test junk";
const PRIVATE_KEY = `0x${"12".repeat(32)}`;
const PAYMENT_PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
const PAY_TO = "0x2222222222222222222222222222222222222222" as const;
const ROUTER_KEY = "private-router-key-that-must-stay-secret";
const DEVICE_CODE = "private-device-code-that-must-stay-secret";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runSwarm lead mode", () => {
  it("passes tty approvals to the lead and delegated children", async () => {
    const fixture = await swarmFixture();
    const approvals: Array<{ member: string; approvals: MemberRunOptions["approvals"] }> = [];
    const deps = orchestrationDeps(fixture, async (member, runOpts) => {
      approvals.push({ member: member.account, approvals: runOpts.approvals });
      return agentDeps(fixture, runOpts, async () => textReply("unused"));
    });
    deps.runAgent = async (_task, memberDeps) => {
      if (memberDeps.runMeta?.parentRunId !== undefined) {
        return finished(memberDeps, "Child completed.");
      }
      await memberDeps.swarm!.delegate({
        member: "team-helper-1",
        task: "Help the lead",
        budgetUsd: "0.25",
        parentRunId: memberDeps.runId!,
        requestId: `${memberDeps.runId!}:approval-mode`,
      });
      return finished(memberDeps, "Lead completed.");
    };

    await runSwarm({ name: "team", task: "Delegate once", mode: "lead", drawUsd: "0.25" }, deps);

    expect(approvals).toEqual([
      { member: "team-lead-1", approvals: "tty" },
      { member: "team-helper-1", approvals: "tty" },
    ]);
  });

  it("reuses an allocation request without another transfer or draw charge", async () => {
    const fixture = await swarmFixture();
    const allocations: Array<Awaited<ReturnType<SwarmRunContext["allocate"]>>> = [];
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("unused")),
    );
    deps.runAgent = async (_task, memberDeps) => {
      const input = { amountUsd: "0.25", requestId: "run_1:allocation" };
      allocations.push(await memberDeps.swarm!.allocate(input));
      allocations.push(await memberDeps.swarm!.allocate(input));
      return finished(memberDeps, "Allocation retried safely.");
    };

    const result = await runSwarm(
      { name: "team", task: "Allocate twice", mode: "lead", drawUsd: "0.25" },
      deps,
    );

    expect(fixture.capital.transfer).toHaveBeenCalledTimes(1);
    expect(allocations).toHaveLength(2);
    expect(allocations[0]?.movementId).toBe(allocations[1]?.movementId);
    expect(result.drawUsedUsd).toBe(0.25);
  });

  it("returns a recorded delegated result without transferring or running the child again", async () => {
    const fixture = await swarmFixture();
    const delegated: Array<Awaited<ReturnType<SwarmRunContext["delegate"]>>> = [];
    let childRuns = 0;
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("unused")),
    );
    deps.runAgent = async (_task, memberDeps) => {
      if (memberDeps.runMeta?.parentRunId !== undefined) {
        childRuns += 1;
        return finished(memberDeps, "Child completed once.");
      }
      const input = {
        member: "team-helper-1",
        task: "Complete once",
        budgetUsd: "0.25",
        parentRunId: memberDeps.runId!,
        requestId: "run_1:delegate",
      };
      delegated.push(await memberDeps.swarm!.delegate(input));
      delegated.push(await memberDeps.swarm!.delegate(input));
      return finished(memberDeps, "Delegation retried safely.");
    };

    const result = await runSwarm(
      { name: "team", task: "Delegate twice", mode: "lead", drawUsd: "0.25" },
      deps,
    );

    expect(fixture.capital.transfer).toHaveBeenCalledTimes(1);
    expect(childRuns).toBe(1);
    expect(delegated).toHaveLength(2);
    expect(delegated[1]).toEqual(delegated[0]);
    expect(result.members.filter((member) => member.member === "team-helper-1")).toHaveLength(1);
    await expect(
      readDelegationRecord(fixture.home, treasuryRequestMovementId("team", "run_1:delegate")),
    ).resolves.toMatchObject({
      childRunId: "run_2",
      result: { answer: "Child completed once.", budgetUsd: 0.25 },
    });
  });

  it("starts a child once from a sent delegation whose child record was never written", async () => {
    const fixture = await swarmFixture();
    const requestId = "run_1:recover-child";
    await allocateFromTreasury(
      {
        name: "team",
        member: "team-helper-1",
        amountUsd: "0.25",
        reason: "delegate",
        requestId,
      },
      fixture.capital,
    );
    vi.mocked(fixture.capital.transfer!).mockClear();
    let childRuns = 0;
    let childLimit = 0n;
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("unused")),
    );
    deps.runAgent = async (_task, memberDeps) => {
      if (memberDeps.runMeta?.parentRunId !== undefined) {
        childRuns += 1;
        childLimit = memberDeps.budget!.limitAtomic;
        return finished(memberDeps, "Recovered child completed.");
      }
      const input = {
        member: "team-helper-1",
        task: "Recover the child",
        budgetUsd: "0.25",
        parentRunId: memberDeps.runId!,
        requestId,
      };
      await memberDeps.swarm!.delegate(input);
      return finished(memberDeps, "Recovery complete.");
    };

    await runSwarm(
      { name: "team", task: "Recover delegation", mode: "lead", drawUsd: "0.25" },
      deps,
    );

    expect(fixture.capital.transfer).not.toHaveBeenCalled();
    expect(childRuns).toBe(1);
    expect(childLimit).toBe(250_000n);
    await expect(
      readDelegationRecord(fixture.home, treasuryRequestMovementId("team", requestId)),
    ).resolves.toMatchObject({ result: { answer: "Recovered child completed." } });
  });

  it("includes a recovered completed child in the aggregate result", async () => {
    const fixture = await swarmFixture();
    const requestId = "run_1:recorded-child";
    const allocation = await allocateFromTreasury(
      {
        name: "team",
        member: "team-helper-1",
        amountUsd: "0.25",
        reason: "delegate",
        requestId,
      },
      fixture.capital,
    );
    await writeDelegationRecord(fixture.home, {
      v: 1,
      movementId: allocation.movementId!,
      requestId,
      swarm: "team",
      member: "team-helper-1",
      budgetUsd: "0.25",
      childRunId: "run_recorded",
      startedAt: new Date(NOW).toISOString(),
      result: {
        runId: "run_recorded",
        answer: "Recorded child completed.",
        stoppedBecause: { reason: "finished" },
        spentUsd: 0,
        budgetUsd: 0.25,
      },
    });
    vi.mocked(fixture.capital.transfer!).mockClear();
    let childRuns = 0;
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("unused")),
    );
    deps.runAgent = async (_task, memberDeps) => {
      if (memberDeps.runMeta?.parentRunId !== undefined) childRuns += 1;
      await memberDeps.swarm!.delegate({
        member: "team-helper-1",
        task: "Do not rerun",
        budgetUsd: "0.25",
        parentRunId: memberDeps.runId!,
        requestId,
      });
      return finished(memberDeps, "Recorded result handled.");
    };

    const result = await runSwarm(
      { name: "team", task: "Recover completed delegation", mode: "lead", drawUsd: "0.25" },
      deps,
    );

    expect(fixture.capital.transfer).not.toHaveBeenCalled();
    expect(childRuns).toBe(0);
    expect(result.members.find((member) => member.member === "team-helper-1")).toMatchObject({
      member: "team-helper-1",
      runId: "run_recorded",
      answer: "Recorded child completed.",
      stoppedBecause: { reason: "finished" },
      status: "finished",
    });
  });

  it("returns an interrupted result from a child record without transferring or rerunning", async () => {
    const fixture = await swarmFixture();
    const requestId = "run_1:interrupted-child";
    const childRunId = "run_111111111111111111111111";
    const allocation = await allocateFromTreasury(
      {
        name: "team",
        member: "team-helper-1",
        amountUsd: "0.25",
        reason: "delegate",
        requestId,
      },
      fixture.capital,
    );
    await writeDelegationRecord(fixture.home, {
      v: 1,
      movementId: allocation.movementId!,
      requestId,
      swarm: "team",
      member: "team-helper-1",
      budgetUsd: "0.25",
      childRunId,
      startedAt: new Date(NOW).toISOString(),
    });
    await appendReceipt(
      {
        id: "paid-before-final-record-failed",
        timestamp: new Date(NOW).toISOString(),
        run: {
          id: childRunId,
          swarm: "team",
          member: "team-helper-1",
          parentRunId: "run_000000000000000000000000",
        },
        wallet: "team-helper-1",
        resourceUrl: "https://paid.example/result",
        quote: { network: BASE_MAINNET_CAIP2, amountAtomic: "200000" },
        status: 200,
        outcome: "paid",
      },
      getVapiPaths(fixture.home).receipts,
    );
    vi.mocked(fixture.capital.transfer!).mockClear();
    let childRuns = 0;
    let delegated: Awaited<ReturnType<SwarmRunContext["delegate"]>> | undefined;
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("unused")),
    );
    deps.runAgent = async (_task, memberDeps) => {
      if (memberDeps.runMeta?.parentRunId !== undefined) childRuns += 1;
      const input = {
        member: "team-helper-1",
        task: "Do not rerun",
        budgetUsd: "0.25",
        parentRunId: memberDeps.runId!,
        requestId,
      };
      delegated = await memberDeps.swarm!.delegate(input);
      return finished(memberDeps, "Interruption handled.");
    };

    const result = await runSwarm(
      { name: "team", task: "Inspect interruption", mode: "lead", drawUsd: "0.25" },
      deps,
    );

    expect(fixture.capital.transfer).not.toHaveBeenCalled();
    expect(childRuns).toBe(0);
    expect(delegated).toEqual({
      member: "team-helper-1",
      runId: childRunId,
      answer: null,
      stoppedBecause: {
        reason: "error",
        detail: `Delegated run ${childRunId} was interrupted before its final record was saved; spending and remaining budget are unknown. Inspect receipts for run ${childRunId} before allocating more.`,
      },
      spentUsd: null,
      budgetUsd: 0.25,
    });
    expect(result.members.find((member) => member.member === "team-helper-1")).toMatchObject({
      member: "team-helper-1",
      runId: childRunId,
      spentUsd: null,
      stoppedBecause: { reason: "error" },
      status: "error",
    });
  });

  it("returns a request conflict as a tool error and lets the lead finish", async () => {
    const fixture = await swarmFixture();
    const requests: ChatRequest[] = [];
    let childRuns = 0;
    const replies = new Map<string, ChatResult[]>([
      [
        "team-lead-1",
        [
          toolReply("same-intent", "swarm_delegate", {
            member: "team-helper-1",
            task: "First task",
            budget_usd: "0.10",
          }),
          toolReply("same-intent", "swarm_delegate", {
            member: "team-helper-1",
            task: "Changed task and budget",
            budget_usd: "0.20",
          }),
          toolReply("finish", "finish", { answer: "Conflict handled." }),
        ],
      ],
      ["team-helper-1", [toolReply("finish-child", "finish", { answer: "Done once." })]],
    ]);
    const deps = orchestrationDeps(fixture, async (member, runOpts) => {
      const scripted = [...(replies.get(member.account) ?? [])];
      return agentDeps(fixture, runOpts, async (request) => {
        if (member.account === "team-lead-1") requests.push(structuredClone(request));
        else childRuns += 1;
        const reply = scripted.shift();
        if (reply === undefined) throw new Error(`No reply for ${member.account}.`);
        return reply;
      });
    });

    const result = await runSwarm(
      { name: "team", task: "Handle conflict", mode: "lead", drawUsd: "1.00" },
      deps,
    );

    expect(result.members[0]).toMatchObject({ answer: "Conflict handled.", status: "finished" });
    expect(fixture.capital.transfer).toHaveBeenCalledTimes(1);
    expect(childRuns).toBe(1);
    expect(requests[2]?.messages.at(-1)?.content).toContain("swarm_delegate failed.");
  });

  it("funds a one-level child budget, removes treasury tools, declines an over-budget call, and releases the lock", async () => {
    const fixture = await swarmFixture();
    const requests = new Map<string, ChatRequest[]>();
    const replies = new Map<string, ChatResult[]>([
      [
        "team-lead-1",
        [
          toolReply("delegate", "swarm_delegate", {
            member: "team-helper-1",
            task: "Check the expensive listing",
            budget_usd: "0.25",
          }),
          toolReply("finish-lead", "finish", { answer: "Lead finished after delegation." }),
        ],
      ],
      [
        "team-helper-1",
        [
          toolReply("search", "call_search", { query: "expensive", network: null }),
          toolReply("pay", "call_pay", {
            ref: "expensive",
            body: null,
            max_usd: 0.5,
          }),
          toolReply("finish-child", "finish", { answer: "Child continued safely." }),
        ],
      ],
    ]);
    let childBudget: RunBudget | undefined;
    let paid = false;
    let childAcquiredLock = false;
    const deps = orchestrationDeps(fixture, async (member, runOpts) => {
      if (member.account === "team-helper-1") childBudget = runOpts.budget;
      const accountRequests: ChatRequest[] = [];
      requests.set(member.account, accountRequests);
      const scripted = [...(replies.get(member.account) ?? [])];
      return agentDeps(
        fixture,
        runOpts,
        async (request) => {
          accountRequests.push(structuredClone(request));
          if (member.account === "team-helper-1" && accountRequests.length === 1) {
            await withSwarmLock(fixture.home, "team", async () => {
              childAcquiredLock = true;
            });
          }
          const reply = scripted.shift();
          if (reply === undefined) throw new Error(`No reply for ${member.account}.`);
          return reply;
        },
        {
          search: async () => [
            {
              ref: "expensive",
              name: "Expensive",
              priceUsd: 0.5,
              verification: "verified",
            },
          ],
          inspect: async () => inspected("$0.50"),
          pay: async () => {
            runOpts.budget.reserve(500_000n, "expensive-payment");
            paid = true;
            return {
              ok: true,
              status: 200,
              body: { paid: true },
              amountUsd: 0.5,
              network: "eip155:8453",
            };
          },
        },
      );
    });

    const result = await runSwarm(
      { name: "team", task: "Lead the research", mode: "lead", drawUsd: "0.25" },
      deps,
    );

    expect(result).toMatchObject({
      runId: "run_1",
      drawUsedUsd: 0.25,
      drawLimitUsd: 0.25,
      members: [
        { member: "team-lead-1", runId: "run_1", status: "finished" },
        {
          member: "team-helper-1",
          runId: "run_2",
          parentRunId: "run_1",
          answer: "Child continued safely.",
          spentUsd: 0,
          budgetUsd: 0.25,
          status: "finished",
        },
        { member: "team-writer-1", status: "skipped", reason: "not_linked" },
      ],
    });
    expect(childBudget?.limitAtomic).toBe(250_000n);
    expect(paid).toBe(false);
    expect(childAcquiredLock).toBe(true);
    expect(requests.get("team-helper-1")?.[0]?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "swarm_delegate" }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: "swarm_allocate" }) }),
      ]),
    );
    const movements = await movementFiles(fixture.home);
    expect(movements).toHaveLength(1);
    await expect(readMovement(fixture.home, movements[0]!)).resolves.toMatchObject({
      reason: "delegate",
      from: "team-treasury",
      legs: [{ from: "team-treasury", to: "team-helper-1", status: "sent" }],
    });
  });

  it("returns a thrown child failure and lets the lead finish", async () => {
    const fixture = await swarmFixture();
    let delegated: Awaited<ReturnType<SwarmRunContext["delegate"]>> | undefined;
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("unused")),
    );
    deps.runAgent = async (_task, memberDeps) => {
      if (memberDeps.runMeta?.parentRunId !== undefined) throw new Error("child exploded");
      delegated = await memberDeps.swarm!.delegate({
        member: "team-helper-1",
        task: "Fail safely",
        budgetUsd: "0.10",
        parentRunId: memberDeps.runId!,
        requestId: `${memberDeps.runId!}:child-failure`,
      });
      return finished(memberDeps, "Lead still finished.");
    };

    const result = await runSwarm(
      { name: "team", task: "Delegate safely", mode: "lead", drawUsd: "0.10" },
      deps,
    );

    expect(delegated).toMatchObject({
      member: "team-helper-1",
      stoppedBecause: { reason: "error", detail: "child exploded" },
    });
    expect(result.members.slice(0, 2)).toMatchObject([
      { member: "team-lead-1", answer: "Lead still finished.", status: "finished" },
      { member: "team-helper-1", status: "error" },
    ]);
  });

  it("carries the parent run into a delegated member's paid-call receipt", async () => {
    const fixture = await swarmFixture();
    const receiptsPath = join(fixture.home, "child-receipts.jsonl");
    const config = getDefaultConfig();
    const listing = externalApiHit();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(marketplacePage([listing])))
      .mockResolvedValueOnce(paymentRequired(config))
      .mockResolvedValueOnce(
        Response.json(
          { paid: true },
          {
            headers: {
              "payment-response": Buffer.from(
                JSON.stringify({ success: true, transaction: `0x${"77".repeat(32)}` }),
                "utf8",
              ).toString("base64"),
            },
          },
        ),
      );
    const scripts = new Map<string, ChatResult[]>([
      [
        "team-lead-1",
        [
          toolReply("delegate", "swarm_delegate", {
            member: "team-helper-1",
            task: "Buy the weather result",
            budget_usd: "0.01",
          }),
          toolReply("finish-lead", "finish", { answer: "Lead incorporated the result." }),
        ],
      ],
      [
        "team-helper-1",
        [
          toolReply("search", "call_search", { query: "weather", network: null }),
          toolReply("pay", "call_pay", {
            ref: listing.ref,
            body: null,
            max_usd: 0.0025,
          }),
          toolReply("finish-child", "finish", { answer: "Weather purchased." }),
        ],
      ],
    ]);
    const profileSchema = createAgentProfileSchema([
      "call.search",
      "call.inspect",
      "call.pay",
      "call.read",
    ]);
    const deps = orchestrationDeps(fixture, async (member, runOpts) => {
      const scripted = [...(scripts.get(member.account) ?? [textReply("Done.")])];
      const chat = async () => scripted.shift() ?? textReply("Done.");
      if (member.account !== "team-helper-1") {
        return agentDeps(fixture, runOpts, chat);
      }
      const created = createAgentRunDeps({
        profile: runOpts.profile,
        config,
        home: fixture.home,
        account: privateKeyToAccount(PAYMENT_PRIVATE_KEY),
        wallet: member.account,
        spendCaps: { perCallAtomic: "1000000", perDayAtomic: "1000000" },
        chat,
        approve: async () => false,
        fetchImpl,
        receiptsPath,
        budget: runOpts.budget,
        runId: runOpts.runId,
        runMeta: runOpts.runMeta,
        ceilingSweep: false,
      });
      return { ...created, inspect: async () => inspected("$0.0025") };
    });
    deps.readProfile = async (account) => {
      const profile = await readAgentProfile(fixture.home, account, { schema: profileSchema });
      return { ...profile, verifiedOnly: false };
    };
    let runId = 0;
    deps.newRunId = () => `run_${(runId += 1).toString(16).padStart(24, "0")}`;

    const result = await runSwarm(
      { name: "team", task: "Lead the paid research", mode: "lead", drawUsd: "0.01" },
      deps,
    );

    expect(result.members.slice(0, 2)).toMatchObject([
      { member: "team-lead-1", runId: result.runId, status: "finished" },
      {
        member: "team-helper-1",
        parentRunId: result.runId,
        answer: "Weather purchased.",
        spentUsd: 0.0025,
        status: "finished",
      },
    ]);
    await expect(readReceipts(receiptsPath)).resolves.toEqual([
      expect.objectContaining({
        run: {
          id: result.members[1]!.runId,
          swarm: "team",
          member: "team-helper-1",
          parentRunId: result.runId,
        },
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects self, treasury, unlinked, and non-member delegation before movement", async () => {
    const fixture = await swarmFixture();
    const errors: string[] = [];
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("unused")),
    );
    deps.runAgent = async (_task, memberDeps) => {
      for (const member of ["team-lead-1", "team-treasury", "team-writer-1", "outsider"]) {
        try {
          await memberDeps.swarm!.delegate({
            member,
            task: "Invalid delegation",
            budgetUsd: "0.10",
            parentRunId: memberDeps.runId!,
            requestId: `${memberDeps.runId!}:invalid:${member}`,
          });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return finished(memberDeps, "Validation complete.");
    };

    await runSwarm({ name: "team", task: "Validate targets", mode: "lead", drawUsd: "1.00" }, deps);

    expect(errors).toEqual([
      "Member team-lead-1 cannot delegate to itself.",
      "Cannot delegate to swarm treasury team-treasury.",
      "Member team-writer-1 is not eligible: not_linked.",
      "Member outsider is not in swarm team.",
    ]);
    expect(await movementFiles(fixture.home)).toEqual([]);
  });

  it("declines delegation over the shared draw without creating a movement", async () => {
    const fixture = await swarmFixture();
    const requests: ChatRequest[] = [];
    const scripted = [
      toolReply("delegate", "swarm_delegate", {
        member: "team-helper-1",
        task: "Too expensive",
        budget_usd: "0.50",
      }),
      toolReply("finish", "finish", { answer: "Handled refusal." }),
    ];
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async (request) => {
        requests.push(structuredClone(request));
        return scripted.shift() ?? textReply("Done.");
      }),
    );

    const result = await runSwarm(
      { name: "team", task: "Stay inside the draw", mode: "lead", drawUsd: "0.25" },
      deps,
    );

    expect(result.members[0]).toMatchObject({ answer: "Handled refusal.", status: "finished" });
    expect(requests[1]?.messages.at(-1)?.content).toContain("$0.25 left to draw");
    expect(await movementFiles(fixture.home)).toEqual([]);
  });
});

describe("runSwarm each mode", () => {
  it("passes decline approvals to every independently run member", async () => {
    const fixture = await swarmFixture();
    const approvals: Array<{ member: string; approvals: MemberRunOptions["approvals"] }> = [];
    const deps = orchestrationDeps(fixture, async (member, runOpts) => {
      approvals.push({ member: member.account, approvals: runOpts.approvals });
      return agentDeps(fixture, runOpts, async () => textReply("Done independently."));
    });

    await runSwarm(
      { name: "team", task: "Run independently", mode: "each", budgetUsd: "0.25" },
      deps,
    );

    expect(approvals).toEqual([
      { member: "team-lead-1", approvals: "decline" },
      { member: "team-helper-1", approvals: "decline" },
      { member: "team-trader-1", approvals: "decline" },
    ]);
  });

  it.each([
    [2, 2],
    [undefined, 3],
  ] as const)("limits concurrency %s and preserves swarm order", async (concurrency, expected) => {
    const fixture = await swarmFixture();
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedExpected = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (maxInFlight === expected) reached();
        await gate;
        inFlight -= 1;
        return textReply("Done independently.");
      }),
    );

    const pending = runSwarm(
      {
        name: "team",
        task: "Run independently",
        mode: "each",
        budgetUsd: "0.25",
        ...(concurrency === undefined ? {} : { concurrency }),
      },
      deps,
    );
    await reachedExpected;
    expect(maxInFlight).toBe(expected);
    release();
    const result = await pending;

    expect(result.members.map((member) => [member.member, member.status])).toEqual([
      ["team-lead-1", "finished"],
      ["team-helper-1", "finished"],
      ["team-trader-1", "finished"],
      ["team-writer-1", "skipped"],
    ]);
    expect(result.members[3]).toMatchObject({ reason: "not_linked", runId: null });
  });

  it("declines owner approval without prompting, exposes no treasury tools, and builds net", async () => {
    const fixture = await swarmFixture();
    const approve = vi.fn().mockRejectedValue(new Error("must not prompt"));
    const pay = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      amountUsd: 0.75,
      network: "eip155:8453",
    });
    const requests: ChatRequest[] = [];
    const scripts = new Map<string, ChatResult[]>([
      [
        "team-lead-1",
        [
          toolReply("search", "call_search", { query: "premium", network: null }),
          toolReply("pay", "call_pay", { ref: "premium", body: null, max_usd: 0.75 }),
          toolReply("finish", "finish", { answer: "Declined and continued." }),
        ],
      ],
    ]);
    const deps = orchestrationDeps(fixture, async (member, runOpts) => {
      const scripted = [...(scripts.get(member.account) ?? [textReply("Done.")])];
      return agentDeps(
        fixture,
        runOpts,
        async (request) => {
          requests.push(structuredClone(request));
          return scripted.shift() ?? textReply("Done.");
        },
        {
          approve,
          search: async () => [
            {
              ref: "premium",
              name: "Premium",
              priceUsd: 0.75,
              verification: "verified",
            },
          ],
          inspect: async () => inspected("$0.75"),
          pay,
        },
      );
    });

    const result = await runSwarm(
      { name: "team", task: "Try the premium listing", mode: "each", budgetUsd: "1.00" },
      deps,
    );

    expect(approve).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    expect(
      requests.flatMap((request) =>
        Array.isArray(request.tools)
          ? request.tools.map((tool) => (tool as { function: { name: string } }).function.name)
          : [],
      ),
    ).not.toEqual(expect.arrayContaining(["swarm_delegate", "swarm_allocate"]));
    expect(result.net).toEqual(
      fixture.swarm.members.map((member) => ({
        member: member.account,
        balanceUsd: "1.00",
        allocatedInUsd: "0.25",
        sweptOutUsd: "0.00",
        netUsd: "0.75",
      })),
    );
  });

  it("does not hold the swarm lock while a member chat runs", async () => {
    const fixture = await swarmFixture();
    let acquired = 0;
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => {
        await withSwarmLock(fixture.home, "team", async () => {
          acquired += 1;
        });
        return textReply("Unlocked.");
      }),
    );

    await runSwarm(
      {
        name: "team",
        task: "Check the lock",
        mode: "each",
        budgetUsd: "0.10",
        concurrency: 1,
      },
      deps,
    );

    expect(acquired).toBe(3);
  });
});

describe("runSwarm validation and safe results", () => {
  it("uses a validated caller-supplied top-level run id", async () => {
    const fixture = await swarmFixture();
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("Done.")),
    );
    const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaa";

    const result = await runSwarm(
      { name: "team", task: "Use this run id", mode: "lead", runId },
      deps,
    );

    expect(result.runId).toBe(runId);
    expect(result.members[0]?.runId).toBe(runId);
    await expect(
      runSwarm(
        { name: "team", task: "Reject this run id", mode: "lead", runId: "../escape" },
        deps,
      ),
    ).rejects.toThrow("Invalid swarm run id: ../escape.");
  });

  it("binds a loaded profile wallet to the validated swarm member", async () => {
    const fixture = await swarmFixture();
    const seen: Array<{ member: string; wallet: string }> = [];
    const deps = orchestrationDeps(fixture, async (member, runOpts) => {
      seen.push({ member: member.account, wallet: runOpts.profile.wallet });
      return agentDeps(fixture, runOpts, async () => textReply("Bound safely."));
    });
    deps.readProfile = async (account) => ({
      ...(await readAgentProfile(fixture.home, account, {
        schema: createAgentProfileSchema(["call.search", "call.inspect", "call.pay", "call.read"]),
      })),
      wallet: "team-treasury",
    });

    const result = await runSwarm(
      { name: "team", task: "Use the member wallet", mode: "lead", budgetUsd: "0.10" },
      deps,
    );

    expect(result.members[0]).toMatchObject({ member: "team-lead-1", status: "finished" });
    expect(seen).toEqual([{ member: "team-lead-1", wallet: "team-lead-1" }]);
  });

  it("reports no_lead, invalid_lead, invalid_amount, and no_eligible_members", async () => {
    const fixture = await swarmFixture();
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("Done.")),
    );

    for (const value of ["0", "0.001", "-1", "abc"]) {
      await expect(
        runSwarm({ name: "team", task: "Invalid", mode: "each", drawUsd: value }, deps),
      ).rejects.toMatchObject({ code: "invalid_amount" });
      await expect(
        runSwarm({ name: "team", task: "Invalid", mode: "each", budgetUsd: value }, deps),
      ).rejects.toMatchObject({ code: "invalid_amount" });
    }

    await expect(
      runSwarm({ name: "team", task: "Invalid lead", mode: "lead", lead: "team-writer-1" }, deps),
    ).rejects.toMatchObject({ code: "invalid_lead" });

    fixture.swarm.members[0]!.role = "helper";
    await writeSwarm(fixture.home, fixture.swarm);
    await expect(
      runSwarm({ name: "team", task: "No lead", mode: "lead" }, deps),
    ).rejects.toMatchObject({ code: "no_lead" });

    for (const member of fixture.swarm.members) await fixture.store.clearLink(member.account);
    await expect(
      runSwarm({ name: "team", task: "Nobody", mode: "each" }, deps),
    ).rejects.toMatchObject({ code: "no_eligible_members" });
  });

  it("keeps fixture secrets out of answers and status errors", async () => {
    const fixture = await swarmFixture();
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () =>
        textReply([PHRASE, PRIVATE_KEY, ROUTER_KEY, DEVICE_CODE].join("\n")),
      ),
    );
    deps.status = async () => {
      throw new Error(`Status failed with Bearer ${ROUTER_KEY}`);
    };

    const result = await runSwarm(
      { name: "team", task: "Return safely", mode: "each", budgetUsd: "0.10" },
      deps,
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(PHRASE);
    expect(serialized).not.toContain(PRIVATE_KEY);
    expect(serialized).not.toContain(ROUTER_KEY);
    expect(serialized).not.toContain(DEVICE_CODE);
    expect(result.net).toEqual([]);
    expect(result.netError).toContain("[redacted]");
  });

  it("returns an empty net table and the short status message on status failure", async () => {
    const fixture = await swarmFixture();
    const deps = orchestrationDeps(fixture, async (_member, runOpts) =>
      agentDeps(fixture, runOpts, async () => textReply("Done.")),
    );
    deps.status = async () => {
      throw new Error("status unavailable");
    };

    const result = await runSwarm(
      { name: "team", task: "Run", mode: "each", budgetUsd: "0.10" },
      deps,
    );

    expect(result.net).toEqual([]);
    expect(result.netError).toBe("status unavailable");
  });
});

type Fixture = {
  home: string;
  store: WalletStore;
  swarm: SwarmFile;
  balances: Map<string, bigint>;
  capital: SwarmCapitalDeps;
};

async function swarmFixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "vapi-swarm-run-"));
  temporaryDirectories.push(home);
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    available: true,
    platform: "darwin",
    description: "test store",
    get: async (name) => values.get(name),
    has: async (name) => values.has(name),
    set: async (name, value) => {
      values.set(name, value);
    },
    remove: async (name) => values.delete(name),
  };
  const store = await WalletStore.open(home, { secrets, env: {}, now: () => new Date(NOW) });
  await store.create("main", "", { phrase: PHRASE });
  const setup = await setupSwarm({
    home,
    store,
    secrets,
    apiBase: API_BASE,
    name: "team",
    roles: ["lead", "helper", "trader", "writer"],
    strategy: "targets",
    surface: "cli",
    env: {},
    hostname: "Test Host",
    now: () => new Date(NOW),
    startDeviceLink: async (args) => linkStart(args.label),
    pollDeviceLink: async () => ({
      owner: OWNER,
      routerKey: ROUTER_KEY,
      routerBaseUrl: "https://router.vapinetwork.ai",
      tokens: {
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresAt: NOW + 3_600_000,
        scopes: ["mcp:call", "router.use"],
      },
    }),
  });
  await store.clearLink("team-writer-1");
  const balances = new Map<string, bigint>([
    ["main", 0n],
    [setup.swarm.treasury.account, 20_000_000n],
    ...setup.swarm.members.map((member) => [member.account, 0n] as const),
  ]);
  const send = async (args: TransferArgs): Promise<TransferResult> => {
    const amountAtomic = cents(String(args.amountUsd)) * 10_000n;
    balances.set(args.from, (balances.get(args.from) ?? 0n) - amountAtomic);
    balances.set(args.to, (balances.get(args.to) ?? 0n) + amountAtomic);
    return transferResult(args);
  };
  let id = 0;
  let nonce = 0;
  const capital: SwarmCapitalDeps = {
    home,
    store,
    secrets,
    apiBase: API_BASE,
    balanceReader: async ({ account }) => balances.get(account) ?? 0n,
    transfer: vi.fn(send),
    now: () => NOW,
    randomId: () => `mv_swarmrun${String((id += 1)).padStart(2, "0")}`,
    randomNonce: () => `0x${(nonce += 1).toString(16).padStart(64, "0")}` as Hex,
  };
  return { home, store, swarm: setup.swarm, balances, capital };
}

function orchestrationDeps(
  fixture: Fixture,
  depsForMember: RunSwarmDeps["depsForMember"],
): RunSwarmDeps {
  let id = 0;
  return {
    home: fixture.home,
    store: fixture.store,
    capital: fixture.capital,
    depsForMember,
    status: async () => statusResult(fixture),
    newRunId: () => `run_${(id += 1)}`,
    now: () => new Date(NOW),
  };
}

function agentDeps(
  fixture: Fixture,
  runOpts: MemberRunOptions,
  chat: RunAgentDeps["chat"],
  overrides: Partial<Pick<RunAgentDeps, "approve" | "search" | "inspect" | "pay">> = {},
): RunAgentDeps {
  return {
    profile: runOpts.profile,
    config: getDefaultConfig(),
    home: fixture.home,
    chat,
    search: overrides.search ?? vi.fn().mockResolvedValue([]),
    inspect: overrides.inspect ?? vi.fn().mockRejectedValue(new Error("Inspect is unavailable.")),
    pay: overrides.pay ?? vi.fn().mockRejectedValue(new Error("Pay is unavailable.")),
    caps: { perCallUsd: 5 },
    approve: overrides.approve ?? vi.fn().mockResolvedValue(false),
    now: () => new Date(NOW),
    budget: runOpts.budget,
    runId: runOpts.runId,
    runMeta: runOpts.runMeta,
  };
}

function finished(deps: RunAgentDeps, answer: string): RunAgentResult {
  return {
    runId: deps.runId!,
    answer,
    stoppedBecause: { type: "stopped", reason: "finished" },
    paidUsd: 0,
    steps: 1,
    budget: {
      limitUsd: Number(deps.budget!.limitAtomic) / 1_000_000,
      spentUsd: Number(deps.budget!.spentAtomic()) / 1_000_000,
    },
  };
}

function inspected(price: string): Awaited<ReturnType<RunAgentDeps["inspect"]>> {
  return {
    name: "Listing",
    method: "POST",
    url: "https://listing.example/call",
    price,
    description: "A test listing.",
    verification: "verified",
    network: "eip155:8453",
    payment: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x1111111111111111111111111111111111111111",
      payTo: "0x2222222222222222222222222222222222222222",
      checkedAt: new Date(NOW).toISOString(),
    },
  };
}

function statusResult(fixture: Fixture): SwarmStatusResult {
  return {
    swarm: fixture.swarm.name,
    network: fixture.swarm.network,
    strategy: fixture.swarm.policy.strategy,
    treasury: {
      account: fixture.swarm.treasury.account,
      address: fixture.swarm.treasury.address!,
      linked: false,
      balanceAtomic: "20000000",
      balanceUsd: "20.00",
    },
    members: fixture.swarm.members.map((member) => ({
      account: member.account,
      address: member.address!,
      role: member.role,
      weight: member.weight,
      targetUsd: "1.00",
      ceilingUsd: "5.00",
      linked: fixture.store.entry(member.account)?.link !== undefined,
      profile: true,
      balanceAtomic: "1000000",
      balanceUsd: "1.00",
      allocatedInUsd: "0.25",
      sweptOutUsd: "0.00",
      netUsd: "0.75",
    })),
    openMovements: [],
  };
}

function linkStart(label: string): DeviceLinkStart {
  return {
    clientId: `agent_${label}`,
    deviceCode: DEVICE_CODE,
    userCode: "BCDF-GHJK",
    verificationUri: `${API_BASE}/link`,
    verificationUriComplete: `${API_BASE}/link?code=BCDF-GHJK`,
    expiresIn: 600,
    interval: 5,
    autoApproved: true,
  };
}

function transferResult(args: TransferArgs): TransferResult {
  const nonce = args.resume ?? args.nonce;
  if (nonce === undefined) throw new Error("A test transfer requires a nonce.");
  return {
    status: "sent",
    from: args.from,
    to: getAddress("0x2222222222222222222222222222222222222222"),
    toName: args.to,
    toKind: "account",
    amountUsd: String(args.amountUsd),
    amountAtomic: (cents(String(args.amountUsd)) * 10_000n).toString(),
    network: args.network as TransferNetwork,
    txHash: `0x${"ab".repeat(32)}`,
    nonce,
    replayed: args.resume !== undefined,
  };
}

function cents(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
}

async function movementFiles(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "movements")))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function marketplacePage(items: MarketplaceHit[]): MarketplaceDiscoveryPage {
  return {
    protocol: "vapi.marketplace.discovery/1",
    items,
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v1",
  };
}

function externalApiHit(): MarketplaceHit {
  return {
    ref: "https://93.184.216.34/weather",
    kind: "api",
    provenance: "indexed",
    verification: "none",
    execution: {
      mode: "direct",
      url: "https://93.184.216.34/weather",
      method: "POST",
      network: BASE_MAINNET_CAIP2,
    },
    card: {
      title: "External weather API",
      summary: "Weather from the external catalog.",
      badges: [{ code: "external_catalog", label: "External catalog" }],
      facts: [{ label: "Price", value: "$0.0025" }],
    },
    action: { type: "invoke_api", href: "/call/invoke" },
  };
}

function paymentRequired(config: ReturnType<typeof getDefaultConfig>): Response {
  return Response.json(
    {
      x402Version: 2,
      resource: { url: "https://93.184.216.34/weather" },
      accepts: [
        {
          scheme: "exact",
          network: BASE_MAINNET_CAIP2,
          amount: "2500",
          asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    },
    { status: 402 },
  );
}

function toolReply(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    model: "router/test",
    keyUsed: "stake",
  };
}

function textReply(content: string): ChatResult {
  return { content, toolCalls: [], model: "router/test", keyUsed: "stake" };
}
