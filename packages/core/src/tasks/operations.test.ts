import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readSpendLedger } from "../spend-policy.js";
import {
  deliverTaskOperation,
  fundTaskOperation,
  TaskInputError,
  TaskOperationError,
  nextTaskEvents,
  postTask,
  taskPolicyForWallet,
  taskRequest,
} from "./operations.js";
import { missingTasksChain, TasksChainUnavailableError, type TasksChain } from "./chain-port.js";
import { TasksClientError, type TasksClient } from "./client.js";

const directories: string[] = [];
const ORDER = "11111111-1111-4111-8111-111111111111";
const ESCROW = "22222222-2222-4222-8222-222222222222";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HASH = `0x${"ab".repeat(32)}` as const;
const NOW = new Date("2026-10-08T12:00:00.000Z");
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("taskRequest", () => {
  it("maps structural chain errors and keeps a manifest hash", async () => {
    const manifestHash = `0x${"ab".repeat(32)}` as `0x${string}`;
    const error = Object.assign(new Error("separate bundle"), {
      code: "chain_unavailable",
      manifestHash,
    });
    await expect(
      taskRequest("deliver", "deliverEscrow", async () => Promise.reject(error), {
        signInHint: "Run vapi login.",
      }),
    ).rejects.toMatchObject({
      name: "TaskOperationError",
      code: "chain_unavailable",
      message: "An acting wallet is required for task chain operations.",
      manifestHash,
    });
    await expect(
      taskRequest(
        "deliver",
        "deliverEscrow",
        async () => {
          throw new TasksChainUnavailableError(manifestHash);
        },
        { signInHint: "Run vapi login." },
      ),
    ).rejects.toBeInstanceOf(TaskOperationError);
  });

  it("maps pending, authentication, and invalid-input errors", async () => {
    const invoke = (route: Parameters<typeof taskRequest>[1], error: Error) =>
      taskRequest("verb", route, async () => Promise.reject(error), {
        signInHint: "Sign in here.",
      });
    await expect(
      invoke("events", new TasksClientError("http", "missing", 404)),
    ).rejects.toMatchObject({
      code: "not_available",
      message: "verb is not available on this server yet.",
    });
    await expect(
      invoke("getOrder", new TasksClientError("http", "denied", 401)),
    ).rejects.toMatchObject({
      code: "not_signed_in",
      message: "verb needs sign-in. Sign in here.",
    });
    await expect(
      invoke("createOrder", new TasksClientError("http", "denied", 403)),
    ).rejects.toMatchObject({
      message: "verb needs sign-in. Sign in here.",
    });
    await expect(
      invoke("createOrder", new TasksClientError("http", "denied", 401)),
    ).rejects.toMatchObject({ message: "verb needs sign-in. Sign in here." });
    await expect(
      invoke("propose", new TasksClientError("invalid_input", "bad input", 400)),
    ).rejects.toBeInstanceOf(TaskInputError);
    await expect(
      invoke("getOrder", new TasksClientError("http", "missing scope", 403, "insufficient_scope")),
    ).rejects.toMatchObject({
      code: "insufficient_scope",
      message: "This sign-in lacks Tasks access. Run vapi login again.",
    });
    await expect(
      taskRequest(
        "verb",
        "getOrder",
        async () => {
          throw new TasksClientError("http", "missing scope", 403, "insufficient_scope");
        },
        { signInHint: "Call auth.link for the acting wallet." },
      ),
    ).rejects.toMatchObject({
      message: "This sign-in lacks Tasks access. Call auth.link again.",
    });
  });
});

describe("nextTaskEvents", () => {
  const event = (sequence: number) => ({
    sequence,
    type: "task.open",
    at: "now",
    actor: "actor",
    payload: {},
  });

  it("sorts, filters prior sequences, and advances to the maximum", () => {
    const page = { events: [event(5), event(3), event(5), event(2)], nextAfter: 4 };
    const result = nextTaskEvents(page, 2);
    expect(result.events.map(({ sequence }) => sequence)).toEqual([3, 5]);
    expect(result.nextCursor).toBe(5);
    expect(page.events.map(({ sequence }) => sequence)).toEqual([5, 3, 5, 2]);
  });

  it("rejects regressed cursors and malformed event sequences", () => {
    expect(() => nextTaskEvents({ events: [], nextAfter: 1 }, 2)).toThrow(
      "The task event cursor regressed or is malformed.",
    );
    expect(() => nextTaskEvents({ events: [event(-1)], nextAfter: 2 }, 1)).toThrow(
      "A task event sequence is malformed.",
    );
  });
});

describe("postTask", () => {
  it("reports the created order when webhook configuration fails without replaying creation", async () => {
    const createOrder = vi.fn().mockResolvedValue({ workOrder: { id: ORDER } });
    const configureWebhook = vi
      .fn()
      .mockRejectedValue(new TasksClientError("http", "webhook rejected", 400, "invalid_request"));
    const client = {
      deployment: vi.fn().mockResolvedValue({ network: "eip155:8453", feeBp: null }),
      createOrder,
      configureWebhook,
    } as unknown as TasksClient;
    await expect(
      postTask(
        {
          client,
          chain: missingTasksChain,
          baseUrl: "https://tasks.example",
          randomUUID: () => KEY,
          signInHint: "Run vapi login.",
        },
        {
          order: {
            title: "Build an API",
            description: "Build the complete public API.",
            policyFamily: "software-api",
          },
          amount: 1_000_000n,
          deadlineAt: "2026-10-10T12:00:00.000Z",
          webhook: "https://example.com/hook",
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining(`Task ${ORDER} was created`),
    });
    expect(createOrder).toHaveBeenCalledOnce();
    expect(configureWebhook).toHaveBeenCalledOnce();
  });
});

describe("taskPolicyForWallet", () => {
  const profile = {
    version: 1 as const,
    name: "worker",
    wallet: "main",
    model: "model",
    instructions: "",
    verifiedOnly: true,
    approveAboveUsd: 3,
    maxPerTaskUsd: 7,
    autoReleaseBelowUsd: 2,
    maxSteps: 12,
    paused: false,
    grants: [],
    tools: ["call.search"],
    createdAt: "2026-10-08T00:00:00.000Z",
  };
  const schema = { parse: (value: unknown) => ({ ...profile, ...(value as object) }) } as never;

  it("returns defaults and one matching profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-task-policy-"));
    directories.push(directory);
    await expect(taskPolicyForWallet({ directory, wallet: "main", schema })).resolves.toMatchObject(
      {
        maxPerTaskUsd: 100,
        approveAboveUsd: 0.5,
        autoReleaseBelowUsd: 25,
        source: "defaults",
      },
    );
    await mkdir(join(directory, "agents"));
    await writeFile(join(directory, "agents", "worker.json"), JSON.stringify({}));
    await expect(taskPolicyForWallet({ directory, wallet: "main", schema })).resolves.toEqual({
      maxPerTaskUsd: 7,
      approveAboveUsd: 3,
      autoReleaseBelowUsd: 2,
      source: "agent-profile",
    });
  });

  it("rejects ambiguity and invalid profiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vapi-task-policy-"));
    directories.push(directory);
    await mkdir(join(directory, "agents"));
    await Promise.all(
      ["one", "two"].map((name) =>
        writeFile(join(directory, "agents", `${name}.json`), JSON.stringify({})),
      ),
    );
    await expect(taskPolicyForWallet({ directory, wallet: "main", schema })).rejects.toMatchObject({
      name: "TaskInputError",
      message: "More than one agent profile uses wallet main; task policy is ambiguous.",
    });
    const warn = vi.fn();
    await expect(
      taskPolicyForWallet({
        directory,
        wallet: "main",
        schema: {
          parse: () => {
            throw new Error("invalid");
          },
        } as never,
        warn,
      }),
    ).rejects.toMatchObject({
      name: "TaskInputError",
      message: "An invalid agent profile prevents task policy selection.",
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

function operationFixture(amountBaseUnits = "100000000") {
  const order = {
    workOrder: {
      version: "work-order-view-v1",
      id: ORDER,
      milestones: [
        {
          id: ESCROW,
          workOrderId: ORDER,
          amountBaseUnits,
          state: "agreed",
          escrowState: "created",
          resolution: null,
          escrowContract: "0x1111111111111111111111111111111111111111",
        },
      ],
    },
  };
  const client = {
    getOrder: vi.fn().mockResolvedValue(order),
    deployment: vi.fn().mockResolvedValue({ configured: false }),
    uploadFile: vi.fn().mockResolvedValue({
      file: {
        id: "33333333-3333-4333-8333-333333333333",
        fileName: "proof.md",
        sha256: "ab".repeat(32),
        sizeBytes: 5,
      },
    }),
  } as unknown as TasksClient;
  const result = { txHash: HASH, operation: {}, milestone: {} } as never;
  const chain: TasksChain = {
    available: true,
    createEscrow: vi.fn(),
    fund: vi.fn().mockResolvedValue(result),
    deliver: vi.fn().mockResolvedValue(result),
    release: vi.fn(),
    refund: vi.fn(),
    dispute: vi.fn(),
    disputeFee: vi.fn(),
    counterEvidence: vi.fn(),
    resolveUnmatched: vi.fn(),
    signScopeMessage: vi.fn(),
  };
  return {
    client,
    chain,
    result,
    baseUrl: "https://tasks.example",
    randomUUID: () => KEY,
    signInHint: "Run vapi login.",
  };
}

async function fundingFixture(amount = "100000000") {
  const directory = await mkdtemp(join(tmpdir(), "vapi-task-fund-"));
  directories.push(directory);
  return {
    context: operationFixture(amount),
    input: {
      id: ORDER,
      policy: {
        maxPerTaskUsd: 100,
        approveAboveUsd: 50,
        autoReleaseBelowUsd: 25,
        source: "defaults" as const,
      },
      caps: { perCallAtomic: "1", perDayAtomic: "200000000" },
      wallet: "main" as const,
      ledgerPath: join(directory, "spend-ledger.json"),
      now: () => new Date(NOW),
      idempotencyKey: () => KEY,
    },
  };
}

describe("fundTaskOperation", () => {
  it("leaves policy refusals, approval waits, and unavailable chains unreserved", async () => {
    const refused = await fundingFixture("100000001");
    await expect(fundTaskOperation(refused.context, refused.input)).resolves.toMatchObject({
      ok: false,
      reason: "policy.perTask",
    });
    expect(refused.context.chain.fund).not.toHaveBeenCalled();
    await expect(stat(refused.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    const approval = await fundingFixture();
    await expect(
      fundTaskOperation(approval.context, { ...approval.input, approval: { granted: false } }),
    ).resolves.toMatchObject({ ok: false, approval: true });
    expect(approval.context.chain.fund).not.toHaveBeenCalled();
    await expect(stat(approval.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    const unavailable = await fundingFixture("10000000");
    unavailable.context.chain = missingTasksChain;
    await expect(
      fundTaskOperation(unavailable.context, { ...unavailable.input, approval: { granted: true } }),
    ).rejects.toMatchObject({ code: "chain_unavailable" });
    await expect(stat(unavailable.input.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves per-day ledger bytes and reserves before one chain call", async () => {
    const refused = await fundingFixture();
    const original = `${JSON.stringify({ date: "2026-10-08", spentAtomic: "100000001" })}\n`;
    await writeFile(refused.input.ledgerPath, original);
    await expect(fundTaskOperation(refused.context, refused.input)).resolves.toMatchObject({
      ok: false,
      reason: "policy.perDay",
    });
    expect(await readFile(refused.input.ledgerPath, "utf8")).toBe(original);

    const funded = await fundingFixture();
    let hookCalled = false;
    vi.mocked(funded.context.chain.fund).mockImplementation(async () => {
      expect(hookCalled).toBe(true);
      expect(readFileSync(funded.input.ledgerPath, "utf8")).toContain(KEY);
      return funded.context.result;
    });
    await expect(
      fundTaskOperation(funded.context, {
        ...funded.input,
        approval: { granted: true },
        beforeChainFund: () => {
          expect(readFileSync(funded.input.ledgerPath, "utf8")).toContain(KEY);
          hookCalled = true;
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(hookCalled).toBe(true);
    expect(funded.context.chain.fund).toHaveBeenCalledTimes(1);
    await expect(readSpendLedger(funded.input.ledgerPath, NOW, "main")).resolves.toMatchObject({
      spentAtomic: "100000000",
    });
  });

  it("normalizes a raced cap failure", async () => {
    const raced = await fundingFixture();
    const racedBytes = `${JSON.stringify({ date: "2026-10-08", spentAtomic: "200000000" })}\n`;
    const hook = vi.fn();
    await expect(
      fundTaskOperation(raced.context, {
        ...raced.input,
        approval: {
          ask: async () => {
            await writeFile(raced.input.ledgerPath, racedBytes);
            return true;
          },
        },
        beforeChainFund: hook,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "policy.perDay" });
    expect(raced.context.chain.fund).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(await readFile(raced.input.ledgerPath, "utf8")).toBe(racedBytes);
  });
});

describe("deliverTaskOperation", () => {
  it("carries the prepared manifest hash through missing-chain mapping", async () => {
    const context = operationFixture();
    context.chain = missingTasksChain;
    const onPrepared = vi.fn();
    await expect(
      deliverTaskOperation(context, {
        id: ORDER,
        files: [
          {
            name: "proof.md",
            bytes: new TextEncoder().encode("proof"),
            contentType: "text/markdown",
          },
        ],
        note: "Delivery note",
        onPrepared,
      }),
    ).rejects.toMatchObject({
      code: "chain_unavailable",
      manifestHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
    });
    expect(onPrepared).toHaveBeenCalledOnce();
  });
});
