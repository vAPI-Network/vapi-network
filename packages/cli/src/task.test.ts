import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyMessage } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletStore, type SecretStore } from "@vapi-network/core";
import { agentSecretAccounts } from "@vapi-network/core/agent-link";
import {
  canonicalJson,
  prepareDeliveryManifest,
  TasksChainError,
  TasksChainUnavailableError,
  TasksClientError,
  type TasksClient,
  type TasksChain,
  type TasksChainResult,
  type TasksClientOptions,
} from "../../core/src/tasks/index.js";
import { tasksResponseSchemas } from "../../core/src/tasks/types.js";
import { runCli, type CliDependencies } from "./cli.js";
import { parseTaskDuration, TASK_HELP } from "./task.js";

const ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const ESCROW = "0x2222222222222222222222222222222222222222";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const BRIEF = "Build a page with a working contact form.";
const homes: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function card(state: "open" | "paid" = "open") {
  return {
    id: ID,
    title: "Build a page",
    brief: BRIEF,
    briefFull: BRIEF,
    shape: "task" as const,
    amount: { gross: "100", fee: "5", net: "95", asset: "USDC" as const, feeBp: 500 },
    deadlineAt: null,
    durationSeconds: 172800,
    createdAt: NOW.toISOString(),
    state,
    poster: {
      address: ADDRESS,
      badge: {
        kind: "human" as const,
        source: "none" as const,
        owner: null,
        verifiedWorker: false,
      },
    },
    takers: 0,
    awards: 0,
    maxAwards: 1,
    proofKinds: ["url"],
    audience: "public",
    children: [],
    receiptUrl: state === "paid" ? `https://receipts.example/${ESCROW}` : null,
  };
}

function order() {
  return tasksResponseSchemas.getOrder.parse({
    workOrder: {
      version: "work-order-view-v1",
      id: ID,
      state: "open",
      title: "Build a page",
      description: BRIEF,
      policyFamily: "general-digital",
      listingDeliveryTimeSeconds: 172800,
      clientAddress: ADDRESS,
      invitedProviderAddress: null,
      acceptedProposalId: null,
      threadId: null,
      role: "client",
      canFinalize: false,
      proposals: [],
      milestones: [],
      events: [],
      review: null,
      publishedAt: NOW.toISOString(),
      completedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  });
}

function fakeClient(overrides: Partial<TasksClient> = {}): TasksClient {
  let uploadIndex = 0;
  return {
    board: vi.fn(async () => ({
      pinned: null,
      cards: [card()],
      nextCursor: null,
      numbers: {
        escrowedNow: "100",
        paidOutAllTime: "0",
        tasksSettled: 0,
        agentsActive30d: 1,
        feeBp: 500,
        call: null,
      },
    })),
    publicTask: vi.fn(async () => card()),
    getOrder: vi.fn(async () => order()),
    createOrder: vi.fn(async () => order()),
    deployment: vi.fn(async () => ({
      configured: true,
      chainId: 8453,
      network: "eip155:8453",
      feeBp: 500,
      explorerUrl: "https://basescan.org",
      escrowContract: ESCROW,
      feeRouter: ADDRESS,
      usdc: ADDRESS,
      capabilities: { erc3009Funding: true, vapiVerify: false },
      eip3009Domain: null,
      maxEscrowAmountBaseUnits: "500000000",
      defaults: { workDurationSeconds: 172800 },
      verifyReviewPriceBaseUnits: null,
    })),
    propose: vi.fn(async (_id, input) => ({ proposal: { id: PROPOSAL_ID, ...input } })),
    submit: vi.fn(async (_id, input) => ({ proposal: { id: PROPOSAL_ID, ...input } })),
    acceptProposal: vi.fn(async () => order()),
    sendMessage: vi.fn(async (_id, input) => ({ message: { id: "message-1", ...input } })),
    listMessages: vi.fn(async () => ({ messages: [], page: { nextBeforeSeq: null } })),
    uploadFile: vi.fn(async (input) => ({
      file: {
        id:
          uploadIndex++ === 0
            ? FILE_ID
            : `44444444-4444-4444-8444-${String(uploadIndex).padStart(12, "0")}`,
        fileName: input.fileName,
        sha256: "ab".repeat(32),
        sizeBytes: input.bytes.length,
        purpose: "delivery",
        mimeType: "text/plain",
        state: "ready",
        createdAt: NOW.toISOString(),
      },
    })),
    ...overrides,
  } as TasksClient;
}

async function fixture(linked = true, client = fakeClient()) {
  const home = await mkdtemp(join(tmpdir(), "vapi-task-cli-"));
  homes.push(home);
  vi.stubEnv("VAPI_HOME", home);
  const entries = new Map<string, string>();
  const secrets: SecretStore = {
    available: true,
    platform: "darwin",
    description: "test secret store",
    get: async (key) => entries.get(key),
    has: async (key) => entries.has(key),
    set: async (key, value) => {
      entries.set(key, value);
    },
    remove: async (key) => entries.delete(key),
  };
  const store = await WalletStore.open(home, { secrets, env: {}, now: () => NOW });
  await store.create("worker", "test-passphrase");
  await store.setSpendCaps("worker", { perCallAtomic: "1", perDayAtomic: "200000000" });
  if (linked) {
    await store.setLink("worker", {
      apiBase: "https://api.vapinetwork.ai",
      clientId: "test-worker",
      owner: ADDRESS,
      label: "worker",
      scopes: ["tasks:read", "tasks:write"],
      linkedAt: NOW.toISOString(),
    });
    await secrets.set(
      agentSecretAccounts("worker").tokens,
      JSON.stringify({
        accessToken: "test-bearer",
        refreshToken: "test-refresh",
        expiresAt: NOW.getTime() + 86400000,
        scopes: ["tasks:read", "tasks:write"],
      }),
    );
  }
  const dependencies: CliDependencies = {
    env: {},
    interactive: false,
    secretStore: secrets,
    now: () => NOW,
    fetchImpl: vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
    tasks: { client, randomUUID: () => KEY },
  };
  return { home, client, dependencies, store, secrets };
}

async function invoke(
  argv: string[],
  dependencies: CliDependencies,
  json = true,
  multipleJsonLines = false,
) {
  const stdout: string[] = [],
    stderr: string[] = [];
  const code = await runCli(
    ["task", ...argv, ...(json ? ["--json"] : [])],
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    dependencies,
  );
  const values = json ? stdout.map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  if (json && !multipleJsonLines) expect(stdout).toHaveLength(1);
  return {
    code,
    stdout,
    stderr,
    values,
    value: json ? values.at(-1) : undefined,
  };
}

function milestoneOrder(
  options: {
    role?: "client" | "provider" | "proposer";
    state?: "open" | "awarded" | "completed" | "cancelled";
    escrowState?: "created" | "locked" | "submitted" | "disputed" | "resolved" | null;
    amount?: string;
    milestoneState?: "agreed" | "funded" | "delivered" | "released" | "refunded" | "evaluating";
    resolution?: "release" | "refund" | "split" | null;
  } = {},
) {
  const base = order().workOrder;
  return tasksResponseSchemas.getOrder.parse({
    workOrder: {
      ...base,
      role: options.role ?? "client",
      state: options.state ?? "awarded",
      milestones: [
        {
          id: PROPOSAL_ID,
          workOrderId: ID,
          ordinal: 1,
          state: options.milestoneState ?? "agreed",
          terms: {
            version: "work-milestone-terms-v1",
            title: "Build a page",
            description: BRIEF,
            acceptanceCriteria: ["Contact form works"],
            workDurationSeconds: 172800,
            acceptanceWindowSeconds: 604800,
            budget: {
              network: "eip155:8453",
              asset: `eip155:8453/erc20:${ADDRESS}`,
              amountBaseUnits: options.amount ?? "100000000",
            },
            escrow: { protocol: "escrow-v1", contract: ESCROW },
            evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: false },
          },
          termsHash: `0x${"ab".repeat(32)}`,
          termsFrozenAt: NOW.toISOString(),
          network: "eip155:8453",
          asset: `eip155:8453/erc20:${ADDRESS}`,
          amountBaseUnits: options.amount ?? "100000000",
          escrowProtocol: "escrow-v1",
          escrowContract: ESCROW,
          escrowState: options.escrowState === undefined ? "locked" : options.escrowState,
          resolution: options.resolution ?? null,
          offerDeadlineAt: null,
          workDeadlineAt: null,
          acceptanceDeadlineAt: null,
          dispute: null,
          chainOperation: null,
          artifact: null,
          delivery: null,
          fundingTxHash: null,
          settlementTxHash: null,
          fundedAt: NOW.toISOString(),
          deliveredAt: null,
          settledAt: null,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    },
  });
}

function chainResult(
  state: "funded" | "delivered" | "released" | "refunded" | "disputed" = "funded",
): TasksChainResult {
  const operation = tasksResponseSchemas.fundEscrow.parse({
    operation: {
      id: FILE_ID,
      kind: "escrow-funding",
      state: "confirmed",
      step: "fund-with-authorization",
      expectedActor: ADDRESS,
      transactionHash: `0x${"cd".repeat(32)}`,
      plan: null,
    },
    milestone: { id: PROPOSAL_ID, workOrderId: ID },
  }).operation;
  return {
    txHash: hex("cd".repeat(32)),
    operation,
    milestone: {
      id: PROPOSAL_ID,
      workOrderId: ID,
      state: state === "disputed" ? "evaluating" : state,
      escrowState: "locked",
      resolution: null,
    },
  };
}

function hex(value: string): `0x${string}` {
  return `0x${value}`;
}

function fakeChain(overrides: Partial<TasksChain> = {}): TasksChain {
  return {
    available: true,
    createEscrow: vi.fn(async () => chainResult()),
    fund: vi.fn(async () => chainResult()),
    deliver: vi.fn(async () => chainResult("delivered")),
    release: vi.fn(async () => chainResult("released")),
    refund: vi.fn(async () => chainResult("refunded")),
    dispute: vi.fn(async () => chainResult("disputed")),
    signScopeMessage: vi.fn(async (): Promise<`0x${string}`> => hex("ef".repeat(65))),
    ...overrides,
  } satisfies TasksChain;
}

async function writeProfile(
  home: string,
  values: Partial<{
    name: string;
    wallet: string;
    approveAboveUsd: number;
    maxPerTaskUsd: number;
    autoReleaseBelowUsd: number;
  }> = {},
) {
  await mkdir(join(home, "agents"), { recursive: true });
  await writeFile(
    join(home, "agents", `${values.name ?? "builder"}.json`),
    JSON.stringify({
      version: 1,
      name: values.name ?? "builder",
      wallet: values.wallet ?? "worker",
      model: "test",
      instructions: "Complete the task.",
      tools: ["call.search"],
      verifiedOnly: true,
      approveAboveUsd: values.approveAboveUsd ?? 200,
      maxPerTaskUsd: values.maxPerTaskUsd ?? 200,
      autoReleaseBelowUsd: values.autoReleaseBelowUsd ?? 200,
      maxSteps: 12,
      paused: false,
      grants: [],
      createdAt: NOW.toISOString(),
    }),
  );
}

function scopeFixture(
  proposedByRole: "client" | "provider" = "client",
): Awaited<ReturnType<TasksClient["getScopes"]>>["scopes"][number] {
  return tasksResponseSchemas.getScopes.parse({
    scopes: [
      {
        id: FILE_ID,
        workOrderId: ID,
        trancheOrdinal: 1,
        version: 1,
        state: "proposed",
        structuredTerms: {
          version: "work-milestone-terms-v1",
          title: "Build a page",
          description: BRIEF,
          acceptanceCriteria: ["Contact form works"],
          workDurationSeconds: 172800,
          acceptanceWindowSeconds: 604800,
          budget: {
            network: "eip155:8453",
            asset: `eip155:8453/erc20:${ADDRESS}`,
            amountBaseUnits: "100000000",
          },
          escrow: { protocol: "escrow-v1", contract: ESCROW },
          evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: false },
          deliverables: ["A working page"],
          revisionCount: 0,
          deadline: NOW.toISOString(),
        },
        brief: BRIEF,
        termsHash: `0x${"ab".repeat(32)}`,
        proposedByRole,
        proposerAddress: ADDRESS,
        proposerSignature: `0x${"cd".repeat(65)}`,
        counterpartyAddress: null,
        counterpartySignature: null,
        acceptedAt: null,
        milestoneId: null,
        createdAt: NOW.toISOString(),
        signingPayload: {
          version: "work-scope-signature-v1",
          workOrderId: ID,
          trancheOrdinal: 1,
          scopeVersion: 1,
          termsHash: `0x${"ab".repeat(32)}`,
        },
      },
    ],
  }).scopes[0]!;
}

const postArgs = [
  "post",
  "--title",
  "Build a page",
  "--brief",
  "-",
  "--amount",
  "100",
  "--deadline",
  "48h",
];

describe("vapi task", () => {
  it("documents implemented verbs and the exit codes without opening a wallet", async () => {
    const result = await invoke(["--help"], {});
    expect(result.code).toBe(0);
    expect(result.value).toMatchObject({ command: "task help" });
    for (const verb of [
      "search",
      "show",
      "post",
      "propose",
      "submit",
      "award",
      "message",
      "thread",
      "status",
    ])
      expect(result.value!.help).toContain(`vapi task ${verb}`);
    for (const text of ["policy refusal", "invalid usage", "approval", "3", "--json"])
      expect(result.value!.help).toContain(text);
  });

  it.each(["nonsense"])("rejects the unknown verb %s", async (verb) => {
    const result = await invoke([verb], {});
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({ ok: false, error: { code: "usage_error" } });
    expect((result.value!.error as { message: string }).message).toContain("search");
    expect((result.value!.error as { message: string }).message).toContain("status");
  });

  it("exits 1 for task fund --bogus while non-task usage still exits 2", async () => {
    const { dependencies } = await fixture();
    const human = await invoke(["fund", ID, "--bogus"], dependencies, false);
    expect(human.code).toBe(1);
    expect(human.stderr).toEqual(["Unknown option --bogus."]);
    const json = await invoke(["fund", ID, "--bogus"], dependencies);
    expect(json.code).toBe(1);
    expect(json.value).toEqual({
      ok: false,
      error: { code: "usage_error", message: "Unknown option --bogus." },
    });

    const stdout: string[] = [],
      stderr: string[] = [];
    const io = {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };
    expect(await runCli(["init", "--networks", "base,foo"], io, dependencies)).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["--networks supports base, arc and solana."]);
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the canonical task error envelope with leading --json", async () => {
    const { dependencies } = await fixture();
    const stdout: string[] = [];
    const code = await runCli(
      ["--json", "task", "show", ID, "--wallet", "worker", "--account", "worker"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      dependencies,
    );
    expect(code).toBe(1);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ok: false,
        error: {
          code: "usage_error",
          message: "--wallet and --account cannot be used together.",
        },
      },
    ]);
  });

  it.each([
    ["show"],
    ["status"],
    ["award", ID],
    ["message", ID],
    ["thread"],
    ["search", "--tab", "wrong"],
    ["search", "--limit", "0"],
    ["search", "--limit", "1.5"],
    ["search", "--min", "bad"],
    ["search", "--limit", "9007199254740992"],
    ["post", "--amount", "bad"],
    ["post", "--title", "ok", "--brief", "-", "--amount", "-1", "--deadline", "48h"],
    [...postArgs.slice(0, -1), "5s"],
    [...postArgs, "--webhook", "http://example.com"],
    [...postArgs, "--intake", "wrong"],
    [...postArgs, "--max-awards", "51"],
    [...postArgs.slice(0, -1), "2026-10-08T12:09:59.999Z"],
    [...postArgs.slice(0, -1), "garbage"],
    ["propose", ID, "--price", "1", "--duration", "garbage", "--note", "Some terms"],
    ["propose", ID, "--price", "bad", "--duration", "2d", "--note", "Some terms"],
    ["submit", ID],
    ["submit", ID, "--proof", "http://example.com"],
    ["thread", ID, "--after", "no"],
    ["award", ID, "bad"],
    ["message", ID, " "],
    ["search", "--api", "https://example.com"],
  ])("rejects invalid arguments %j through the global usage error JSON", async (...argv) => {
    const { dependencies } = await fixture();
    dependencies.readStdin = async () => BRIEF;
    const result = await invoke(argv, dependencies);
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({
      ok: false,
      error: { code: "usage_error", message: expect.any(String) },
    });
  });

  it("queries the public board and applies exact USD and open filters", async () => {
    const client = fakeClient();
    const board = await client.board();
    client.board = vi.fn(async () => ({
      ...board,
      pinned: card("paid"),
      cards: [
        card(),
        { ...card(), id: "small", amount: { ...card().amount, gross: "49.999999" } },
        card("paid"),
      ],
    }));
    const { dependencies } = await fixture(false, client);
    const result = await invoke(
      ["search", "--open", "--min", "50", "--tab", "closing", "--limit", "2"],
      dependencies,
    );
    expect(result.code).toBe(0);
    expect(client.board).toHaveBeenCalledWith({ tab: "closing", limit: 2 });
    expect(result.value!.cards).toEqual([card()]);
    expect(result.value!.pinned).toBeNull();
  });

  it("maps an unavailable board to the existing global JSON error shape", async () => {
    const { dependencies } = await fixture(
      false,
      fakeClient({
        board: async () => {
          throw new TasksClientError("http", "HTTP 404", 404);
        },
      }),
    );
    const result = await invoke(["search"], dependencies);
    expect(result.code).toBe(1);
    expect(result.value).toEqual({
      ok: false,
      error: { code: "not_available", message: "search is not available on this server yet." },
    });
  });

  it("uses authenticated show, and public status even when signed in", async () => {
    const { client, dependencies } = await fixture();
    expect((await invoke(["show", ID], dependencies)).code).toBe(0);
    expect(client.getOrder).toHaveBeenCalledWith(ID);
    const result = await invoke(["status", ID], dependencies);
    expect(result.code).toBe(0);
    expect(result.value!.task).toEqual(card());
    expect(client.publicTask).toHaveBeenCalledWith(ID);
  });

  it("prints the server receipt URL for a settled public task", async () => {
    const { dependencies } = await fixture(
      false,
      fakeClient({ publicTask: async () => card("paid") }),
    );
    const human = await invoke(["show", ID], dependencies, false);
    expect(human.code).toBe(0);
    expect(human.stdout.join("\n")).toContain(card("paid").receiptUrl);
    const json = await invoke(["show", ID], dependencies);
    expect(json.value).toMatchObject({
      receiptUrl: card("paid").receiptUrl,
      receiptUrlSource: "server",
    });
  });

  it("reports missing tasks without calling them unavailable", async () => {
    const { dependencies } = await fixture(false, fakeClient({ publicTask: async () => null }));
    const result = await invoke(["status", ID], dependencies);
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({ ok: false, error: { code: "not_found" } });
    dependencies.tasks!.client = fakeClient({
      getOrder: async () => {
        throw new TasksClientError("http", "Task not found", 404, "not_found");
      },
    });
  });

  it.each([500, undefined])(
    "reads stdin and prints deployed money with feeBp %s",
    async (feeBp) => {
      const client = fakeClient();
      const deployment = await client.deployment();
      client.deployment = vi.fn(async () => {
        const rest = { ...deployment };
        delete rest.feeBp;
        return feeBp === undefined ? rest : { ...rest, feeBp };
      });
      const { dependencies } = await fixture(true, client);
      dependencies.readStdin = vi.fn(async () => BRIEF);
      const result = await invoke(postArgs, dependencies);
      expect(result.code).toBe(0);
      expect(dependencies.readStdin).toHaveBeenCalledOnce();
      expect(client.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Build a page",
          description: BRIEF,
          policyFamily: "general-digital",
        }),
        { idempotencyKey: KEY },
      );
      expect(result.value!.money).toMatchObject({
        feeBp: feeBp ?? null,
        gross: { baseUnits: "100000000" },
      });
      const human = await invoke(postArgs, dependencies, false);
      expect(human.stdout.join("\n")).toContain(
        feeBp === undefined ? "fee unavailable" : "$100.00 gross · $5.00 fee · $95.00 net",
      );
      expect(human.stdout.join("\n")).toContain("Posting a task moves no money.");
    },
  );

  it("reads a brief file and accepts the exact injected ten-minute deadline", async () => {
    const { home, client, dependencies } = await fixture();
    const path = join(home, "brief.md");
    await writeFile(path, BRIEF);
    const result = await invoke(
      [
        "post",
        "--title",
        "Build a page",
        "--brief",
        path,
        "--amount",
        "0.000001",
        "--deadline",
        "2026-10-08T12:10:00.000Z",
      ],
      dependencies,
    );
    expect(result.code).toBe(0);
    expect(client.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ description: BRIEF }),
      { idempotencyKey: KEY },
    );
  });

  it.each(["post", "propose", "submit", "award", "message", "thread"])(
    "requires the acting wallet's token for %s",
    async (verb) => {
      const { dependencies } = await fixture(false);
      dependencies.readStdin = async () => BRIEF;
      const args: Record<string, string[]> = {
        post: postArgs,
        propose: ["propose", ID, "--price", "95", "--duration", "2d", "--note", BRIEF],
        submit: ["submit", ID, "--proof", "https://example.com/proof"],
        award: ["award", ID, PROPOSAL_ID],
        message: ["message", ID, "Hello"],
        thread: ["thread", ID],
      };
      const result = await invoke(args[verb]!, dependencies);
      expect(result.code).toBe(1);
      expect(result.value).toMatchObject({
        ok: false,
        error: { code: "not_signed_in", message: expect.stringContaining("vapi login") },
      });
    },
  );

  it("signs proposal terms locally without using the chain adapter", async () => {
    const { client, dependencies } = await fixture();
    const result = await invoke(
      ["propose", ID, "--price", "95.123456", "--duration", "2d", "--note", BRIEF],
      dependencies,
    );
    expect(result.code).toBe(0);
    const propose = vi.mocked(client.propose);
    const [id, input, options] = propose.mock.calls[0]!;
    expect(id).toBe(ID);
    expect(options).toEqual({ idempotencyKey: KEY });
    expect(input.signedPayload.milestones[0]!.budget.amountBaseUnits).toBe("95123456");
    expect(input.signedPayload.milestones[0]!.workDurationSeconds).toBe(172800);
    expect(
      await verifyMessage({
        address: input.signedPayload.providerAddress as `0x${string}`,
        message: canonicalJson(input.signedPayload),
        signature: input.signature as `0x${string}`,
      }),
    ).toBe(true);
    expect(result.value!.proposal).toMatchObject({ id: PROPOSAL_ID });
  });

  it("uploads every file and includes finalized sha256 values in the signed submission", async () => {
    const { home, client, dependencies } = await fixture();
    const a = join(home, "a.txt"),
      b = join(home, "b.md");
    await writeFile(a, "proof a");
    await writeFile(b, "proof b");
    const result = await invoke(
      [
        "submit",
        ID,
        "--proof",
        "https://example.com/a",
        "--proof",
        "https://example.com/b",
        "--file",
        a,
        "--file",
        b,
      ],
      dependencies,
    );
    expect(result.code).toBe(0);
    expect(client.uploadFile).toHaveBeenCalledTimes(2);
    const [id, input, options] = vi.mocked(client.submit).mock.calls[0]!;
    expect(id).toBe(ID);
    expect(options).toEqual({ idempotencyKey: KEY });
    expect(input.signedPayload.kind).toBe("submission");
    expect(input.signedPayload.proof).toEqual([
      { kind: "url", value: "https://example.com/a" },
      { kind: "url", value: "https://example.com/b" },
      { kind: "file", value: "ab".repeat(32), label: "a.txt" },
      { kind: "file", value: "ab".repeat(32), label: "b.md" },
    ]);
    expect(result.value!.proposal).toMatchObject({ id: PROPOSAL_ID });
  });

  it.each([401, 403])("explains console sign-in for participant HTTP %s", async (status) => {
    const { dependencies } = await fixture(
      true,
      fakeClient({
        sendMessage: async () => {
          throw new TasksClientError("http", "Denied", status);
        },
      }),
    );
    const result = await invoke(["message", ID, "Hello"], dependencies);
    expect(result.code).toBe(1);
    expect((result.value!.error as { message: string }).message).toContain(
      "does not accept bearer tokens on task routes yet",
    );
    expect((result.value!.error as { message: string }).message).toContain("sign-in");
  });

  it("maps submit route 404 and chain unavailability without extra JSON", async () => {
    const { dependencies } = await fixture(
      true,
      fakeClient({
        submit: async () => {
          throw new TasksClientError("http", "Route missing", 404);
        },
      }),
    );
    const result = await invoke(
      ["submit", ID, "--proof", "https://example.com/proof"],
      dependencies,
    );
    expect(result.code).toBe(1);
    expect(result.value).toEqual({
      ok: false,
      error: { code: "not_available", message: "submit is not available on this server yet." },
    });
    dependencies.tasks!.client = fakeClient({
      sendMessage: async () => {
        throw new TasksChainUnavailableError();
      },
    });
    const unavailable = await invoke(["message", ID, "Hello"], dependencies);
    expect(unavailable.value).toEqual({
      ok: false,
      error: { code: "chain_unavailable", message: "chain operations need C2" },
    });
  });

  it("preserves the unavailable code from a separately bundled chain error", async () => {
    const error = Object.assign(new Error("chain operations need C2"), {
      name: "TasksChainUnavailableError",
      code: "chain_unavailable",
    });
    const { dependencies } = await fixture(
      true,
      fakeClient({
        sendMessage: async () => {
          throw error;
        },
      }),
    );
    const result = await invoke(["message", ID, "Hello"], dependencies);
    expect(result.value).toEqual({
      ok: false,
      error: { code: "chain_unavailable", message: "chain operations need C2" },
    });
  });

  it("awards, sends a message and reads the backward page cursor", async () => {
    const { client, dependencies } = await fixture();
    const award = await invoke(["award", ID, PROPOSAL_ID], dependencies);
    expect(award.code).toBe(0);
    expect(award.value!.workOrder).toEqual(order().workOrder);
    expect(client.acceptProposal).toHaveBeenCalledWith(
      ID,
      { proposalId: PROPOSAL_ID },
      { idempotencyKey: KEY },
    );
    const message = await invoke(["message", ID, "Hello worker"], dependencies);
    expect(message.code).toBe(0);
    expect(message.value!.message).toMatchObject({ body: "Hello worker" });
    expect(client.sendMessage).toHaveBeenCalledWith(
      ID,
      { body: "Hello worker" },
      { idempotencyKey: KEY },
    );
    const thread = await invoke(["thread", ID, "--after", "7"], dependencies);
    expect(thread.code).toBe(0);
    expect(thread.value!.messages).toEqual([]);
    expect(client.listMessages).toHaveBeenCalledWith(ID, { beforeSeq: 7 });
  });

  it("resolves account aliases, VAPI_WALLET, origin and the stored bearer", async () => {
    const { dependencies } = await fixture();
    const factory = vi.fn((_options: TasksClientOptions) => fakeClient());
    dependencies.tasks!.client = factory;
    dependencies.env = {
      VAPI_WALLET: "worker",
      VAPI_REGISTRY_URL: "https://api.vapinetwork.ai/prefix",
    };
    const result = await invoke(["show", ID, "--wallet", "worker"], dependencies);
    expect(result.code).toBe(0);
    expect(result.value!.wallet).toBe("worker");
    expect(result.stderr).toContain(
      "--wallet is now --account; --wallet keeps working for one release.",
    );
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.vapinetwork.ai/prefix",
        token: "test-bearer",
        fetch: expect.any(Function),
      }),
    );
    expect((await invoke(["show", ID, "--account", "worker"], dependencies)).code).toBe(0);
  });

  it.each([
    ["5s", 5000],
    ["10m", 600000],
    ["48h", 172800000],
    ["7d", 604800000],
    ["2026-10-08T13:00:00Z", 3600000],
  ] as const)("parses duration %s with an injected clock", (text, expected) => {
    expect(parseTaskDuration(text, NOW)).toBe(expected);
  });

  it.each([
    "bad",
    "1month",
    "0s",
    "2026-02-30T13:00:00Z",
    "2026-10-08",
    "2026-10-08T11:00:00Z",
    "999999999999999999d",
  ])("rejects duration %s", (text) => {
    expect(() => parseTaskDuration(text, NOW)).toThrow();
  });

  it.each(["show", "status"])(
    "detects an unmounted public route through real C1 transport for %s",
    async (verb) => {
      const { dependencies } = await fixture(false);
      delete dependencies.tasks!.client;
      dependencies.fetchImpl = vi.fn(
        async () => new Response("<h1>Not found</h1>", { status: 404 }),
      );
      const result = await invoke([verb, ID], dependencies);
      expect(result.code).toBe(1);
      expect(result.value).toEqual({
        ok: false,
        error: { code: "not_available", message: `${verb} is not available on this server yet.` },
      });
    },
  );

  it("preserves a structured missing task through real C1 transport", async () => {
    const { dependencies } = await fixture(false);
    delete dependencies.tasks!.client;
    dependencies.fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: "task_not_found", message: "Task not found" } },
        { status: 404 },
      ),
    );
    const result = await invoke(["status", ID], dependencies);
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({
      ok: false,
      error: { code: "not_found", message: expect.stringContaining("was not found") },
    });
  });

  it("preserves an authenticated missing task 404", async () => {
    const { dependencies } = await fixture(
      true,
      fakeClient({
        getOrder: async () => {
          throw new TasksClientError("http", "Task not found", 404, "task_not_found");
        },
      }),
    );
    const result = await invoke(["show", ID], dependencies);
    expect(result.code).toBe(1);
    expect(result.value).toEqual({
      ok: false,
      error: { code: "task_not_found", message: "Task not found" },
    });
  });

  it("does not misreport a missing task on the submission route as unavailable", async () => {
    const { dependencies } = await fixture(
      true,
      fakeClient({
        submit: async () => {
          throw new TasksClientError("http", "Task not found", 404, "task_not_found");
        },
      }),
    );
    const result = await invoke(
      ["submit", ID, "--proof", "https://example.com/proof"],
      dependencies,
    );
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({ error: { code: "task_not_found" } });
  });

  it("reports supported-only post input and no replay after a timeout", async () => {
    const { client, dependencies } = await fixture();
    dependencies.readStdin = async () => BRIEF;
    const result = await invoke(
      [
        ...postArgs,
        "--intake",
        "submissions",
        "--max-awards",
        "3",
        "--webhook",
        "https://example.com/hook",
      ],
      dependencies,
    );
    expect(result.code).toBe(0);
    expect(result.value!.unsupportedFields).toEqual([
      "amount",
      "deadline",
      "intake",
      "maxAwards",
      "webhook",
    ]);
    expect(client.createOrder).toHaveBeenCalledWith(
      { title: "Build a page", description: BRIEF, policyFamily: "general-digital" },
      { idempotencyKey: KEY },
    );
    client.createOrder = vi.fn(async () => {
      throw new TasksClientError("timeout", "The task request timed out.");
    });
    const failed = await invoke(postArgs, dependencies);
    expect(failed.code).toBe(1);
    expect(failed.value).toEqual({
      ok: false,
      error: { code: "timeout", message: "The task request timed out." },
    });
    expect(client.createOrder).toHaveBeenCalledOnce();
  });

  it("stops after an upload failure and never submits partial proof", async () => {
    const { home, client, dependencies } = await fixture();
    const path = join(home, "proof.txt");
    await writeFile(path, "Some evidence");
    client.uploadFile = vi.fn(async () => {
      throw new TasksClientError("http", "Denied", 403);
    });
    const failed = await invoke(
      ["submit", ID, "--proof", "https://example.com/proof", "--file", path],
      dependencies,
    );
    expect(failed.code).toBe(1);
    expect((failed.value!.error as { message: string }).message).toContain(
      "does not accept bearer tokens on task routes yet",
    );
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("uses the account's bearer and refuses credentials for another origin", async () => {
    const { dependencies, store, secrets } = await fixture();
    await store.create("other", "test-passphrase");
    const workerLink = store.entry("worker")!.link!;
    await store.setLink("other", { ...workerLink, clientId: "test-other" });
    await secrets.set(
      agentSecretAccounts("other").tokens,
      JSON.stringify({
        accessToken: "other-bearer",
        refreshable: false,
        expiresAt: NOW.getTime() + 86400000,
        scopes: ["tasks:read", "tasks:write"],
      }),
    );
    const factory = vi.fn((_options: TasksClientOptions) => fakeClient());
    dependencies.tasks!.client = factory;
    expect((await invoke(["show", ID, "--account", "other"], dependencies)).code).toBe(0);
    expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ token: "other-bearer" }));
    dependencies.env = { VAPI_REGISTRY_URL: "https://another.example" };
    const failed = await invoke(["show", ID], dependencies);
    expect(failed.code).toBe(1);
    expect(failed.value).toMatchObject({ error: { code: "not_signed_in" } });
    expect(factory).toHaveBeenCalledOnce();
  });

  it("leaves reads anonymous when the selected wallet has no stored token", async () => {
    const { dependencies, secrets } = await fixture();
    await secrets.remove(agentSecretAccounts("worker").tokens);
    const factory = vi.fn((_options: TasksClientOptions) => fakeClient());
    dependencies.tasks!.client = factory;
    expect((await invoke(["show", ID], dependencies)).code).toBe(0);
    expect(factory.mock.calls[0]![0]).not.toHaveProperty("token");
  });

  it("derives every terminal private receipt from its escrow address", async () => {
    const workOrder = order().workOrder;
    const terms = {
      version: "work-milestone-terms-v1",
      title: "Build a page",
      description: BRIEF,
      acceptanceCriteria: ["Contact form works"],
      workDurationSeconds: 172800,
      acceptanceWindowSeconds: 604800,
      budget: {
        network: "eip155:8453",
        asset: `eip155:8453/erc20:${ADDRESS}`,
        amountBaseUnits: "100000000",
      },
      escrow: { protocol: "escrow-v1", contract: ESCROW },
      evidenceRules: { acceptedInputs: ["text"], exactCommitRequired: false },
    };
    const milestone = {
      id: PROPOSAL_ID,
      workOrderId: ID,
      ordinal: 1,
      state: "released",
      terms,
      termsHash: `0x${"ab".repeat(32)}`,
      termsFrozenAt: NOW.toISOString(),
      network: "eip155:8453",
      asset: terms.budget.asset,
      amountBaseUnits: "100000000",
      escrowProtocol: "escrow-v1",
      escrowContract: ESCROW,
      escrowState: "resolved",
      resolution: "release",
      offerDeadlineAt: null,
      workDeadlineAt: null,
      acceptanceDeadlineAt: null,
      dispute: null,
      chainOperation: null,
      artifact: null,
      fundingTxHash: null,
      settlementTxHash: null,
      fundedAt: null,
      deliveredAt: null,
      settledAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const settled = tasksResponseSchemas.getOrder.parse({
      workOrder: {
        ...workOrder,
        state: "completed",
        milestones: [milestone, { ...milestone, id: KEY, ordinal: 2, escrowContract: ADDRESS }],
      },
    });
    const { dependencies } = await fixture(true, fakeClient({ getOrder: async () => settled }));
    const result = await invoke(["show", ID], dependencies);
    expect(result.code).toBe(0);
    expect(result.value).toMatchObject({
      receiptUrl: `https://api.vapinetwork.ai/receipts/${ESCROW}`,
      receiptUrlSource: "escrow",
    });
    expect(result.value!.receipts).toHaveLength(2);
    const human = await invoke(["show", ID], dependencies, false);
    expect(human.stdout.join("\n")).toContain(
      `Receipt (from escrow): https://api.vapinetwork.ai/receipts/${ESCROW}`,
    );
    expect(human.stdout.join("\n")).toContain(`https://api.vapinetwork.ai/receipts/${ADDRESS}`);
  });

  it("does not derive a receipt from first-dispute settlement metadata", async () => {
    const disputed = milestoneOrder({
      milestoneState: "evaluating",
      escrowState: "disputed",
    });
    if (disputed.workOrder.version !== "work-order-view-v1")
      throw new Error("private order expected");
    const milestone = disputed.workOrder.milestones[0]!;
    milestone.settledAt = NOW.toISOString();
    milestone.settlementTxHash = `0x${"cd".repeat(32)}`;
    const { dependencies } = await fixture(true, fakeClient({ getOrder: async () => disputed }));
    const result = await invoke(["show", ID], dependencies);
    expect(result.code).toBe(0);
    expect(result.value).toMatchObject({ receipts: [] });
    expect(result.value).not.toHaveProperty("receiptUrl");
  });

  it("signs submission proof without changing the signed values", async () => {
    const { dependencies, client } = await fixture();
    expect(
      (await invoke(["submit", ID, "--proof", "https://example.com/proof"], dependencies)).code,
    ).toBe(0);
    const input = vi.mocked(client.submit).mock.calls[0]![1];
    expect(
      await verifyMessage({
        address: input.signedPayload.providerAddress as `0x${string}`,
        signature: input.signature as `0x${string}`,
        message: canonicalJson(input.signedPayload),
      }),
    ).toBe(true);
  });

  describe("escrow task verbs", () => {
    it("only rejects a genuinely unknown verb", async () => {
      const result = await invoke(["nonsense"], {});
      expect(result.code).toBe(1);
      expect(result.value).toMatchObject({ ok: false, error: { code: "usage_error" } });
    });

    it.each([["sign"], ["fund"], ["deliver"], ["release"], ["refund"], ["dispute"], ["watch"]])(
      "parses task %s as a known verb before validating its arguments",
      async (verb) => {
        const result = await invoke([verb], {});
        expect(result.code).toBe(1);
        expect((result.value!.error as { message: string }).message).not.toContain(
          "task <search|show",
        );
      },
    );

    it.each([
      ["dispute", ID, "--evidence-hash", "abcd"],
      ["dispute", ID, "--evidence-hash", `0X${"ab".repeat(32)}`],
      ["deliver", ID, "--note", "Delivered"],
      ["deliver", ID, "--files", "missing.txt"],
      ["watch", ID, "--interval", "999ms"],
      ["watch", ID, "--interval", "1s", "--timeout", "0s"],
      ["watch", ID, "--until", "imaginary"],
    ])("rejects invalid escrow arguments %j", async (...argv) => {
      const { dependencies } = await fixture();
      const result = await invoke(argv, dependencies);
      expect(result.code).toBe(1);
      expect(result.value).toMatchObject({
        ok: false,
        error: { code: "usage_error", message: expect.any(String) },
      });
    });

    it("accepts every known watch terminal state", async () => {
      const states = [
        "open",
        "awarded",
        "funded",
        "delivered",
        "paid",
        "released",
        "refunded",
        "disputed",
        "expired",
        "closed",
        "completed",
        "cancelled",
      ];
      for (const state of states) {
        const client = fakeClient({
          events: vi.fn(async () => ({ events: [], nextAfter: 0 })),
        });
        const { dependencies } = await fixture(true, client);
        let clock = NOW.getTime();
        dependencies.now = () => new Date(clock);
        dependencies.tasks!.sleep = vi.fn(async (milliseconds) => {
          clock += milliseconds;
        });
        const result = await invoke(
          ["watch", ID, "--until", state, "--interval", "1s", "--timeout", "1s"],
          dependencies,
        );
        expect((result.value!.error as { message: string }).message).not.toContain(
          "--until must be",
        );
      }
    });

    it("reads multiple delivery paths from one flag and repeated flags, and rejects directories", async () => {
      const { home, dependencies } = await fixture(
        true,
        fakeClient({ getOrder: async () => milestoneOrder({ role: "provider" }) }),
      );
      const a = join(home, "a.txt"),
        b = join(home, "b.md"),
        directory = join(home, "folder");
      await writeFile(a, "alpha");
      await writeFile(b, "beta");
      await mkdir(directory);
      dependencies.tasks!.chain = fakeChain();
      expect(
        (await invoke(["deliver", ID, "--files", a, b, "--note", "Done"], dependencies, true, true))
          .code,
      ).toBe(0);
      expect(
        (
          await invoke(
            ["deliver", ID, "--files", a, "--files", b, "--note", "Done"],
            dependencies,
            true,
            true,
          )
        ).code,
      ).toBe(0);
      const invalid = await invoke(
        ["deliver", ID, "--files", directory, "--note", "Done"],
        dependencies,
      );
      expect(invalid.code).toBe(1);
      expect((invalid.value!.error as { message: string }).message).toMatch(/file|directory/iu);
    });

    it.each([500, undefined])("reports fund money and feeBp %s", async (feeBp) => {
      const client = fakeClient({ getOrder: async () => milestoneOrder() });
      const deployed = await client.deployment();
      client.deployment = vi.fn(async () => ({ ...deployed, feeBp }));
      const { home, dependencies } = await fixture(true, client);
      await writeProfile(home);
      const chain = fakeChain();
      dependencies.tasks!.chain = chain;
      const result = await invoke(["fund", ID, "--yes"], dependencies);
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({
        command: "task fund",
        wallet: "worker",
        ok: true,
        money: { feeBp: feeBp ?? null, gross: { baseUnits: "100000000" } },
        policySource: "agent-profile",
        policyDecision: "ok",
        result: expect.any(Object),
      });
      expect(chain.fund).toHaveBeenCalledOnce();
    });

    it("uses defaults without a matching profile and fails closed on ambiguous or invalid profiles", async () => {
      const client = fakeClient({ getOrder: async () => milestoneOrder({ amount: "1000000" }) });
      const first = await fixture(true, client);
      first.dependencies.tasks!.chain = fakeChain();
      const fallback = await invoke(["fund", ID, "--yes"], first.dependencies);
      expect(fallback.value).toMatchObject({ policySource: "defaults" });

      const second = await fixture(true, client);
      second.dependencies.tasks!.chain = fakeChain();
      await writeProfile(second.home, { name: "one" });
      await writeProfile(second.home, { name: "two" });
      expect((await invoke(["fund", ID, "--yes"], second.dependencies)).code).toBe(1);

      const third = await fixture(true, client);
      third.dependencies.tasks!.chain = fakeChain();
      await mkdir(join(third.home, "agents"), { recursive: true });
      await writeFile(join(third.home, "agents", "broken.json"), "{");
      expect((await invoke(["fund", ID, "--yes"], third.dependencies)).code).toBe(1);
    });

    it("refuses per-task and daily funding without mutating the ledger", async () => {
      for (const setup of ["perTask", "perDay"] as const) {
        const client = fakeClient({ getOrder: async () => milestoneOrder() });
        const { home, dependencies, store } = await fixture(true, client);
        await writeProfile(home, { maxPerTaskUsd: setup === "perTask" ? 50 : 200 });
        await store.setSpendCaps("worker", {
          perCallAtomic: "200000000",
          perDayAtomic: setup === "perDay" ? "50000000" : "200000000",
        });
        const ledger = join(home, "spend-ledger.json");
        const before =
          setup === "perDay"
            ? JSON.stringify({
                version: 1,
                rows: [{ wallet: "worker", date: "2026-10-08", spentAtomic: "150000001" }],
              })
            : "missing";
        if (setup === "perDay") await writeFile(ledger, before);
        const chain = fakeChain();
        dependencies.tasks!.chain = chain;
        const result = await invoke(["fund", ID, "--yes"], dependencies);
        expect(result.code).toBe(2);
        expect(result.value).toMatchObject({
          ok: false,
          reason: `policy.${setup}`,
          policyDecision: `policy.${setup}`,
        });
        expect(chain.fund).not.toHaveBeenCalled();
        expect(await readFile(ledger, "utf8").catch(() => "missing")).toBe(before);
      }
    });

    it.each([
      { json: true, interactive: true, env: {} },
      { json: false, interactive: false, env: {} },
      { json: false, interactive: true, env: { CI: "" } },
    ])(
      "requires approval without prompting or funding in mode %j",
      async ({ json, interactive, env }) => {
        const client = fakeClient({ getOrder: async () => milestoneOrder() });
        const { home, dependencies } = await fixture(true, client);
        await writeProfile(home, { approveAboveUsd: 10 });
        const chain = fakeChain();
        dependencies.tasks!.chain = chain;
        dependencies.env = env;
        dependencies.interactive = interactive;
        const line = vi.fn(async () => "yes");
        dependencies.prompts = { secret: async () => "test-passphrase", line };
        const result = await invoke(["fund", ID], dependencies, json);
        expect(result.code).toBe(3);
        expect(chain.fund).not.toHaveBeenCalled();
        expect(line).not.toHaveBeenCalled();
        expect(await readFile(join(home, "spend-ledger.json"), "utf8").catch(() => "missing")).toBe(
          "missing",
        );
        if (json)
          expect(result.value).toMatchObject({
            ok: false,
            approval: true,
            policySource: "agent-profile",
          });
      },
    );

    it("prompts visibly for funding and handles yes and decline", async () => {
      for (const answer of ["yes", "no"] as const) {
        const client = fakeClient({ getOrder: async () => milestoneOrder() });
        const { home, dependencies } = await fixture(true, client);
        await writeProfile(home, { approveAboveUsd: 10 });
        const chain = fakeChain();
        dependencies.tasks!.chain = chain;
        dependencies.interactive = true;
        dependencies.prompts = {
          secret: async () => "test-passphrase",
          line: vi.fn(async () => answer),
        };
        const result = await invoke(["fund", ID], dependencies, false);
        expect(dependencies.prompts.line).toHaveBeenCalledWith(
          expect.stringMatching(/\$100\.00|100/),
        );
        expect(chain.fund).toHaveBeenCalledTimes(answer === "yes" ? 1 : 0);
        expect(result.code).toBe(answer === "yes" ? 0 : 1);
        if (answer === "no") expect(result.stderr).toContain("Not approved; nothing was signed.");
      }
    });

    it("refuses a daily-cap race after approval without reserving or signing", async () => {
      const { home, dependencies } = await fixture(
        true,
        fakeClient({ getOrder: async () => milestoneOrder() }),
      );
      await writeProfile(home, { approveAboveUsd: 10 });
      const ledger = join(home, "spend-ledger.json");
      const racedSpend = JSON.stringify({
        version: 1,
        rows: [{ wallet: "worker", date: "2026-10-08", spentAtomic: "150000000" }],
      });
      dependencies.interactive = true;
      dependencies.prompts = {
        secret: async () => "test-passphrase",
        line: async () => {
          await writeFile(ledger, racedSpend);
          return "yes";
        },
      };
      const chain = fakeChain();
      dependencies.tasks!.chain = chain;
      const result = await invoke(["fund", ID], dependencies, false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Policy: refused (policy.perDay).");
      expect(chain.fund).not.toHaveBeenCalled();
      expect(await readFile(ledger, "utf8")).toBe(racedSpend);
    });

    it("checks chain availability before reserving and never retries an ambiguous fund", async () => {
      const client = fakeClient({ getOrder: async () => milestoneOrder() });
      const { home, dependencies } = await fixture(true, client);
      await writeProfile(home);
      const missing = await invoke(["fund", ID, "--yes"], dependencies);
      expect(missing.value).toEqual({
        ok: false,
        error: { code: "chain_unavailable", message: "chain operations need C2" },
      });
      expect(await readFile(join(home, "spend-ledger.json"), "utf8").catch(() => "missing")).toBe(
        "missing",
      );

      const chain = fakeChain({
        fund: vi.fn(async () => {
          throw new TasksChainError("broadcast uncertain", true);
        }),
      });
      dependencies.tasks!.chain = chain;
      expect((await invoke(["fund", ID, "--yes"], dependencies)).code).toBe(1);
      expect(chain.fund).toHaveBeenCalledOnce();
    });

    it("records the escrow-funding reservation before a --yes chain call", async () => {
      const client = fakeClient({ getOrder: async () => milestoneOrder() });
      const { home, dependencies, store } = await fixture(true, client);
      await writeProfile(home, { approveAboveUsd: 10 });
      await store.setSpendCaps("worker", {
        perCallAtomic: "200000000",
        perDayAtomic: "200000000",
      });
      const fund = vi.fn(async () => {
        expect(JSON.parse(await readFile(join(home, "spend-ledger.json"), "utf8"))).toMatchObject({
          version: 1,
          rows: [
            {
              wallet: "worker",
              date: "2026-10-08",
              spentAtomic: "100000000",
              reservations: [{ id: KEY, amountAtomic: "100000000", kind: "escrow-funding" }],
            },
          ],
        });
        return chainResult();
      });
      dependencies.tasks!.chain = fakeChain({ fund });
      expect((await invoke(["fund", ID, "--yes"], dependencies)).code).toBe(0);
      expect(fund).toHaveBeenCalledOnce();
    });

    it("emits one canonical error when delivery preparation succeeds but C2 is unavailable", async () => {
      const client = fakeClient({ getOrder: async () => milestoneOrder({ role: "provider" }) });
      const { home, dependencies } = await fixture(true, client);
      const path = join(home, "result.txt");
      await writeFile(path, "result");
      const unavailable = await invoke(
        ["deliver", ID, "--files", path, "--note", "Finished"],
        dependencies,
        true,
      );
      expect(unavailable.value).toEqual({
        ok: false,
        error: { code: "chain_unavailable", message: "chain operations need C2" },
      });
      expect(client.uploadFile).toHaveBeenCalledOnce();
    });

    it("delivers finalized metadata and returns its hash after chain success", async () => {
      const stdout: string[] = [];
      const client = fakeClient({ getOrder: async () => milestoneOrder({ role: "provider" }) });
      const { home, dependencies } = await fixture(true, client);
      const path = join(home, "local.md");
      await writeFile(path, "result");
      const expected = await prepareDeliveryManifest(
        [{ fileId: FILE_ID, fileName: "local.md", sha256: "ab".repeat(32), sizeBytes: 6 }],
        "Finished",
      );
      const deliver = vi.fn(async (input: Parameters<TasksChain["deliver"]>[0]) => {
        expect(stdout).toEqual([]);
        expect(input.manifest).toEqual(expected);
        return chainResult("delivered");
      });
      dependencies.tasks!.chain = fakeChain({ deliver });
      const code = await runCli(
        ["task", "deliver", ID, "--files", path, "--note", "Finished", "--json"],
        { stdout: (line) => stdout.push(line), stderr: () => {} },
        dependencies,
      );
      expect(code).toBe(0);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]!)).toMatchObject({
        manifestHash: expected.manifestHash,
        result: expect.any(Object),
      });
      expect(client.uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: "local.md",
          bytes: new Uint8Array(Buffer.from("result")),
        }),
      );
      expect(deliver).toHaveBeenCalledOnce();
    });

    it("emits one canonical error when delivery chain execution fails", async () => {
      const client = fakeClient({ getOrder: async () => milestoneOrder({ role: "provider" }) });
      const { home, dependencies } = await fixture(true, client);
      const path = join(home, "result.txt");
      await writeFile(path, "result");
      dependencies.tasks!.chain = fakeChain({
        deliver: vi.fn(async () => {
          throw new TasksChainError("delivery failed", false);
        }),
      });
      const result = await invoke(
        ["deliver", ID, "--files", path, "--note", "Finished"],
        dependencies,
      );
      expect(result.value).toEqual({
        ok: false,
        error: { code: "task_error", message: "delivery failed" },
      });
    });

    it("signs the canonical scope then accepts it, maps roles, and reports a partial create failure", async () => {
      const scope = scopeFixture();
      const accepted = tasksResponseSchemas.signScope.parse({
        scope: { ...scope, state: "accepted", milestoneId: PROPOSAL_ID },
        milestone: {
          id: PROPOSAL_ID,
          workOrderId: ID,
          ordinal: 1,
          termsHash: scope.termsHash,
          termsFrozenAt: NOW.toISOString(),
        },
      });
      const calls: string[] = [];
      const client = fakeClient({
        getOrder: vi.fn(async () => milestoneOrder({ role: "provider", escrowState: null })),
        getScopes: vi.fn(async () => tasksResponseSchemas.getScopes.parse({ scopes: [scope] })),
        signScope: vi.fn(async () => {
          calls.push("client.signScope");
          return accepted;
        }),
      });
      const chain = fakeChain({
        signScopeMessage: vi.fn(async () => {
          calls.push("chain.signScopeMessage");
          return hex("ef".repeat(65));
        }),
        createEscrow: vi.fn(async () => {
          calls.push("chain.createEscrow");
          return chainResult();
        }),
      });
      const { dependencies, store } = await fixture(true, client);
      dependencies.tasks!.chain = chain;
      const result = await invoke(["sign", ID], dependencies);
      expect(chain.signScopeMessage).not.toHaveBeenCalled();
      expect(client.signScope).toHaveBeenCalled();
      expect(chain.createEscrow).toHaveBeenCalledOnce();
      expect(calls).toEqual(["client.signScope", "chain.createEscrow"]);
      const signed = vi.mocked(client.signScope).mock.calls[0]![1];
      expect(signed.signedPayload).toEqual(scope.signingPayload);
      expect(
        await verifyMessage({
          address: (await store.list()).find((wallet) => wallet.name === "worker")!
            .address as `0x${string}`,
          message: canonicalJson(scope.signingPayload),
          signature: signed.signature as `0x${string}`,
        }),
      ).toBe(true);
      expect(result.value).toMatchObject({
        scope: expect.any(Object),
        milestone: expect.any(Object),
        escrowCreation: expect.any(Object),
      });

      chain.createEscrow = vi.fn(async () => {
        throw new TasksChainError("create failed", false);
      });
      const failed = await invoke(["sign", ID], dependencies, true, true);
      expect(failed.code).toBe(1);
      expect(failed.values[0]).toMatchObject({
        scope: expect.any(Object),
        milestone: expect.any(Object),
      });
      expect(failed.value).toMatchObject({
        error: { message: expect.stringContaining("create failed") },
      });
    });

    it("lets the poster accept a scope with a local vault signature without C2", async () => {
      const scope = scopeFixture("provider");
      const accepted = tasksResponseSchemas.signScope.parse({
        scope: { ...scope, state: "accepted", milestoneId: PROPOSAL_ID },
        milestone: {
          id: PROPOSAL_ID,
          workOrderId: ID,
          ordinal: 1,
          termsHash: scope.termsHash,
          termsFrozenAt: NOW.toISOString(),
        },
      });
      const client = fakeClient({
        getOrder: vi.fn(async () => milestoneOrder({ role: "client", escrowState: null })),
        getScopes: vi.fn(async () => tasksResponseSchemas.getScopes.parse({ scopes: [scope] })),
        signScope: vi.fn(async () => accepted),
      });
      const { dependencies } = await fixture(true, client);
      const result = await invoke(["sign", ID], dependencies);
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({ escrowCreation: null });
      expect(client.signScope).toHaveBeenCalledOnce();
    });

    it("accepts a worker scope before reporting missing C2 escrow creation", async () => {
      const scope = scopeFixture();
      const client = fakeClient({
        getOrder: vi.fn(async () => milestoneOrder({ role: "provider", escrowState: null })),
        getScopes: vi.fn(async () => tasksResponseSchemas.getScopes.parse({ scopes: [scope] })),
      });
      const accepted = tasksResponseSchemas.signScope.parse({
        scope: { ...scope, state: "accepted", milestoneId: PROPOSAL_ID },
        milestone: {
          id: PROPOSAL_ID,
          workOrderId: ID,
          ordinal: 1,
          termsHash: scope.termsHash,
          termsFrozenAt: NOW.toISOString(),
        },
      });
      client.signScope = vi.fn(async () => accepted);
      const { dependencies } = await fixture(true, client);
      const result = await invoke(["sign", ID], dependencies, true, true);
      expect(result.values[0]).toMatchObject({ scope: { state: "accepted" } });
      expect(result.value).toEqual({
        ok: false,
        error: { code: "chain_unavailable", message: "chain operations need C2" },
      });
    });

    it.each(["release", "refund", "dispute"])(
      "emits money before task %s and calls the chain once",
      async (verb) => {
        const client = fakeClient({ getOrder: async () => milestoneOrder() });
        const chain = fakeChain();
        const { dependencies } = await fixture(true, client);
        dependencies.tasks!.chain = chain;
        const args = [
          verb,
          ID,
          ...(verb === "dispute" ? ["--evidence-hash", `0x${"ab".repeat(32)}`] : []),
        ];
        const result = await invoke(args, dependencies);
        expect(result.value).toMatchObject({
          command: `task ${verb}`,
          money: { gross: { baseUnits: "100000000" } },
          result: expect.any(Object),
        });
        const operation =
          verb === "release" ? chain.release : verb === "refund" ? chain.refund : chain.dispute;
        expect(operation).toHaveBeenCalledOnce();
        if (verb === "dispute")
          expect(result.values[0]).toMatchObject({
            disputeFee: null,
            disputeFeeNote: expect.stringContaining("unavailable"),
          });
      },
    );

    it("prints settlement money before invoking the chain in human output", async () => {
      for (const verb of ["release", "refund", "dispute"] as const) {
        const stdout: string[] = [];
        const client = fakeClient({ getOrder: async () => milestoneOrder() });
        const observed = vi.fn(async () => {
          expect(stdout.join("\n")).toContain("$100.00 gross");
          return chainResult(
            verb === "release" ? "released" : verb === "refund" ? "refunded" : "disputed",
          );
        });
        const chain = fakeChain({ [verb]: observed });
        const { dependencies } = await fixture(true, client);
        dependencies.tasks!.chain = chain;
        const code = await runCli(
          [
            "task",
            verb,
            ID,
            ...(verb === "dispute" ? ["--evidence-hash", `0x${"ab".repeat(32)}`] : []),
          ],
          { stdout: (line) => stdout.push(line), stderr: () => {} },
          dependencies,
        );
        expect(code).toBe(0);
        expect(observed).toHaveBeenCalledOnce();
      }
    });

    it("watches with cursor advance, event deduplication, until stop and a final summary", async () => {
      const event = {
        sequence: 1,
        type: "task.funded",
        at: NOW.toISOString(),
        actor: ADDRESS,
        payload: { state: "funded" },
      };
      const events = vi
        .fn()
        .mockResolvedValueOnce({ events: [event], nextAfter: 1 })
        .mockResolvedValueOnce({
          events: [
            event,
            { ...event, sequence: 2, type: "task.released", payload: { state: "released" } },
          ],
          nextAfter: 2,
        });
      const { dependencies } = await fixture(true, fakeClient({ events }));
      let clock = NOW.getTime();
      dependencies.now = () => new Date(clock);
      dependencies.tasks!.sleep = vi.fn(async (milliseconds) => {
        clock += milliseconds;
      });
      const result = await invoke(
        ["watch", ID, "--until", "released", "--interval", "1s", "--timeout", "10s"],
        dependencies,
        true,
        true,
      );
      expect(events).toHaveBeenNthCalledWith(1, ID, { after: 0, wait: 0 });
      expect(events).toHaveBeenNthCalledWith(2, ID, { after: 1, wait: 0 });
      expect(result.values.filter((value) => "event" in value)).toHaveLength(2);
      expect(result.value).toMatchObject({
        command: "task watch",
        ok: true,
        until: "released",
        cursor: 2,
      });
    });

    it("times out clearly, maps events 404, and never retries a failed auto-release", async () => {
      const client = fakeClient({
        events: vi.fn(async () => ({ events: [], nextAfter: 0 })),
        getOrder: async () =>
          milestoneOrder({
            amount: "1000000",
            milestoneState: "delivered",
            escrowState: "submitted",
          }),
      });
      const { dependencies } = await fixture(true, client);
      let clock = NOW.getTime();
      dependencies.now = () => new Date(clock);
      dependencies.tasks!.sleep = vi.fn(async (milliseconds) => {
        clock += milliseconds;
      });
      const timeout = await invoke(
        ["watch", ID, "--interval", "1s", "--timeout", "1s"],
        dependencies,
      );
      expect(timeout.code).toBe(1);
      expect((timeout.value!.error as { message: string }).message).toMatch(/timed out|timeout/iu);

      client.events = vi.fn(async () => {
        throw new TasksClientError("http", "missing", 404);
      });
      expect(
        (await invoke(["watch", ID, "--interval", "1s", "--timeout", "1s"], dependencies)).value,
      ).toMatchObject({ error: { code: "not_available" } });

      const chain = fakeChain({
        release: vi.fn(async () => {
          throw new TasksChainError("release failed", true);
        }),
      });
      dependencies.tasks!.chain = chain;
      client.events = vi.fn(async () => ({
        events: [
          {
            sequence: 1,
            type: "task.delivered",
            at: NOW.toISOString(),
            actor: ADDRESS,
            payload: { state: "delivered", milestoneId: PROPOSAL_ID },
          },
        ],
        nextAfter: 1,
      }));
      expect(
        (
          await invoke(
            ["watch", ID, "--auto-release", "--interval", "1s", "--timeout", "10s"],
            dependencies,
            true,
            true,
          )
        ).code,
      ).toBe(1);
      expect(chain.release).toHaveBeenCalledOnce();
    });

    it("does not auto-release an event that arrives after the timeout", async () => {
      let clock = NOW.getTime();
      const client = fakeClient({
        getOrder: async () => milestoneOrder({ amount: "1000000" }),
        events: vi.fn(async () => {
          clock += 2000;
          return {
            events: [
              {
                sequence: 1,
                type: "delivered",
                at: NOW.toISOString(),
                actor: ADDRESS,
                payload: {},
              },
            ],
            nextAfter: 1,
          };
        }),
      });
      const { dependencies } = await fixture(true, client);
      dependencies.now = () => new Date(clock);
      dependencies.tasks!.sleep = vi.fn(async (milliseconds) => {
        clock += milliseconds;
      });
      const chain = fakeChain();
      dependencies.tasks!.chain = chain;
      const result = await invoke(["watch", ID, "--auto-release", "--timeout", "1s"], dependencies);
      expect(result.code).toBe(1);
      expect(result.value).toMatchObject({ error: { code: "timeout" } });
      expect(chain.release).not.toHaveBeenCalled();
    });

    it("auto-releases below the threshold once and requires approval at equality", async () => {
      for (const amount of ["24999999", "25000000"] as const) {
        const stdout: string[] = [];
        const event = {
          sequence: 1,
          type: "task.delivered",
          at: NOW.toISOString(),
          actor: ADDRESS,
          payload: { state: "delivered", milestoneId: PROPOSAL_ID },
        };
        const client = fakeClient({
          events: vi.fn(async () => ({ events: [event], nextAfter: 1 })),
          getOrder: async () =>
            milestoneOrder({ amount, milestoneState: "delivered", escrowState: "submitted" }),
        });
        const { home, dependencies } = await fixture(true, client);
        await writeProfile(home, { autoReleaseBelowUsd: 25 });
        let clock = NOW.getTime();
        dependencies.now = () => new Date(clock);
        dependencies.tasks!.sleep = vi.fn(async (milliseconds) => {
          clock += milliseconds;
        });
        const release = vi.fn(async () => {
          expect(stdout.map((line) => JSON.parse(line))).toContainEqual(
            expect.objectContaining({
              command: "task watch",
              money: expect.objectContaining({ gross: { baseUnits: amount } }),
            }),
          );
          return chainResult("released");
        });
        const chain = fakeChain({ release });
        dependencies.tasks!.chain = chain;
        const code = await runCli(
          ["task", "watch", ID, "--auto-release", "--interval", "1s", "--timeout", "2s", "--json"],
          { stdout: (line) => stdout.push(line), stderr: () => {} },
          dependencies,
        );
        const values = stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(chain.release).toHaveBeenCalledTimes(amount === "24999999" ? 1 : 0);
        if (amount === "25000000") {
          expect(code).toBe(3);
          expect(values.at(-1)).toMatchObject({
            ok: false,
            approval: true,
            money: expect.any(Object),
            policySource: "agent-profile",
          });
          expect(
            await readFile(join(home, "spend-ledger.json"), "utf8").catch(() => "missing"),
          ).toBe("missing");
        }
      }
    });

    it.each([
      {
        name: "released",
        milestoneState: "released" as const,
        escrowState: "resolved" as const,
        resolution: "release" as const,
      },
      {
        name: "disputed",
        milestoneState: "evaluating" as const,
        escrowState: "disputed" as const,
        resolution: null,
      },
    ])("skips a historical delivered event when the milestone is $name", async (current) => {
      const event = {
        sequence: 1,
        type: "task.delivered",
        at: NOW.toISOString(),
        actor: ADDRESS,
        payload: { state: "delivered", milestoneId: PROPOSAL_ID },
      };
      const client = fakeClient({
        events: vi.fn(async () => ({
          events: [
            event,
            { ...event, sequence: 2, type: "task.released", payload: { state: "released" } },
          ],
          nextAfter: 2,
        })),
        getOrder: async () =>
          milestoneOrder({
            amount: "25000000",
            milestoneState: current.milestoneState,
            escrowState: current.escrowState,
            resolution: current.resolution,
          }),
      });
      const { home, dependencies } = await fixture(true, client);
      await writeProfile(home, { autoReleaseBelowUsd: 1 });
      const prompts = vi.fn(async () => "yes");
      dependencies.interactive = true;
      dependencies.prompts = { secret: async () => "test-passphrase", line: prompts };
      const release = vi.fn(async () => chainResult("released"));
      dependencies.tasks!.chain = fakeChain({ release });
      const result = await invoke(
        ["watch", ID, "--until", "paid", "--auto-release", "--timeout", "10s"],
        dependencies,
        true,
        true,
      );
      expect(result.code).toBe(0);
      expect(release).not.toHaveBeenCalled();
      expect(prompts).not.toHaveBeenCalled();
      expect(result.value).toMatchObject({ ok: true, until: "paid", cursor: 2 });
    });

    it("uses exit codes 0, 1 and 3 for success, error, invalid usage and approval", async () => {
      const { dependencies } = await fixture(false);
      expect((await invoke(["status", ID], dependencies)).code).toBe(0);
      expect(
        (
          await invoke(["status", ID], {
            ...dependencies,
            tasks: {
              client: fakeClient({
                publicTask: async () => {
                  throw new Error("broken");
                },
              }),
            },
          })
        ).code,
      ).toBe(1);
      expect((await invoke(["nonsense"], dependencies)).code).toBe(1);
      const approval = await fixture(true, fakeClient({ getOrder: async () => milestoneOrder() }));
      await writeProfile(approval.home, { approveAboveUsd: 10 });
      approval.dependencies.tasks!.chain = fakeChain();
      expect((await invoke(["fund", ID], approval.dependencies)).code).toBe(3);
    });

    it("keeps task copy in the product vocabulary", () => {
      expect(TASK_HELP).not.toMatch(/\b(?:gig|job|freelance|vendor|client)\b|—|!/iu);
    });
  });
});
