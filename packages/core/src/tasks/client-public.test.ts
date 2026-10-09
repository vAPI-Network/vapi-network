import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { canonicalJson } from "./canonical-json.js";
import { createTasksClient } from "./client.js";
import type {
  BoardNumbers,
  BoardResponse,
  EarnResponse,
  EventsResponse,
  FeedResponse,
  FeedRow,
  PublicReceipt,
  PublicTaskCard,
  PublicTaskDetail,
  SubmitInput,
} from "./types.js";

const ID = "11111111-1111-4111-8111-111111111111";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const ESCROW = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;
const SIGNATURE = `0x${"cd".repeat(65)}`;
const NOW = "2026-08-17T12:00:00.000Z";

const badge = {
  kind: "agent",
  source: "agent-link",
  owner: { profileId: ID, label: "Ada" },
  verifiedWorker: true,
} as const;
const amount = {
  gross: "2500000",
  fee: "125000",
  net: "2375000",
  asset: "USDC",
  feeBp: 500,
} as const;
const card: PublicTaskCard = {
  id: ID,
  title: "Audit an API",
  brief: "Review the public API.",
  shape: "open-bounty",
  amount,
  deadlineAt: "2026-09-01T12:00:00.000Z",
  durationSeconds: null,
  createdAt: NOW,
  state: "open",
  poster: { address: ADDRESS, badge },
  takers: 3,
  awards: 1,
  maxAwards: 2,
  proofKinds: ["url", "file"],
  audience: "public",
  receiptUrl: null,
};
const numbers: BoardNumbers = {
  escrowedNow: "2500000",
  paidOutAllTime: "9000000",
  tasksSettled: 4,
  agentsActive30d: 2,
  feeBp: 500,
  call: {
    routedThroughVapi30d: 12,
    paymentsOnBase30d: 8,
    volumeUsdOnBase30d: "42.50",
    asOf: NOW,
  },
};
const row: FeedRow = {
  cursor: `${NOW}:${ID}`,
  at: NOW,
  kind: "posted",
  orderId: ID,
  title: card.title,
  amount: "2500000",
  actor: card.poster,
  counterparty: null,
  receiptUrl: null,
};
const board: BoardResponse = { pinned: card, numbers, cards: [card], nextCursor: "next cursor" };
const detail: PublicTaskDetail = {
  ...card,
  briefFull: "Review the public API and provide findings.",
  children: [{ orderId: ID, worker: card.poster, state: "awarded", receiptUrl: null }],
};
const receipt: PublicReceipt = {
  escrow: ESCROW,
  orderId: ID,
  title: card.title,
  poster: card.poster,
  worker: {
    address: ESCROW,
    badge: { kind: "human", source: "none", owner: null, verifiedWorker: false },
  },
  amount,
  postedAt: NOW,
  fundedAt: NOW,
  deliveredAt: NOW,
  settledAt: NOW,
  outcome: "released",
  allocations: { worker: "2375000", poster: "0", fee: "125000", reviewers: "0" },
  txs: { funded: HASH, settled: HASH },
  explorerUrl: "https://basescan.org",
  disputed: false,
  network: "eip155:8453",
};
const feed: FeedResponse = { rows: [row], nextCursor: row.cursor };
const earn: EarnResponse = {
  numbers,
  topEarners: {
    humans: [{ address: ESCROW, badge: receipt.worker.badge, paidOut30d: "12", tasks: 1 }],
    agents: [{ address: ADDRESS, badge, paidOut30d: "34", tasks: 2 }],
  },
  openByPayout: [card],
};
const events: EventsResponse = {
  events: [
    { sequence: 7, type: "task.funded", at: NOW, actor: ADDRESS, payload: { amount: "2500000" } },
  ],
  nextAfter: 7,
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function recordedFetch(...responses: Response[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(
      input instanceof Request && init === undefined ? input : new Request(input, init),
    );
    const response = responses.shift();
    if (!response) throw new Error("No canned response");
    return response;
  });
  return { fetch, requests };
}

function submissionInput(): SubmitInput {
  return {
    signedPayload: {
      version: "work-proposal-v1",
      workOrderId: ID,
      providerAddress: ADDRESS,
      pricingModel: "fixed",
      milestones: [milestone()],
      kind: "submission",
      proof: [
        { kind: "url", value: "https://example.com/work", label: "Demo" },
        { kind: "file", value: "ab".repeat(32) },
      ],
    },
    signature: SIGNATURE,
  };
}

function milestone() {
  return {
    version: "work-milestone-terms-v1" as const,
    title: "Ship the integration",
    description: "Implement and document it.",
    acceptanceCriteria: ["Tests pass"],
    acceptanceWindowSeconds: 86_400,
    budget: {
      network: "eip155:84532" as const,
      asset: `eip155:84532/erc20:${ESCROW}`,
      amountBaseUnits: "2500000",
    },
    escrow: { protocol: "escrow-v1" as const, contract: ESCROW },
    evidenceRules: { acceptedInputs: ["text" as const], exactCommitRequired: true },
  };
}

const proposal = {
  id: ID,
  workOrderId: ID,
  providerAddress: ADDRESS,
  state: "pending",
  signedPayload: { ...submissionInput().signedPayload, kind: "submission" as const },
  signature: SIGNATURE,
  signatureHash: HASH,
  proposedMilestones: [milestone()],
  acceptedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tasks client public reads", () => {
  it("records public URLs and parses every public response without bearer credentials", async () => {
    const recorder = recordedFetch(
      json(board),
      json(feed),
      json(detail),
      json(receipt),
      json(earn),
    );
    const client = createTasksClient({
      baseUrl: "https://tasks.example/",
      token: "secret",
      fetch: recorder.fetch,
    });
    await expect(client.board({ tab: "closing", limit: 7, cursor: "a/b c" })).resolves.toEqual(
      board,
    );
    await expect(client.feed({ after: "x/y z", limit: 9 })).resolves.toEqual(feed);
    await expect(client.publicTask("id /?#")).resolves.toEqual(detail);
    await expect(client.receipt("escrow /?#")).resolves.toEqual(receipt);
    await expect(client.earn()).resolves.toEqual(earn);
    expect(recorder.requests.map((request) => request.url)).toEqual([
      "https://tasks.example/api/board?tab=closing&limit=7&cursor=a%2Fb+c",
      "https://tasks.example/api/board/feed?after=x%2Fy+z&limit=9",
      "https://tasks.example/api/tasks/id%20%2F%3F%23",
      "https://tasks.example/api/receipts/escrow%20%2F%3F%23",
      "https://tasks.example/api/earn",
    ]);
    expect(recorder.requests.every((request) => request.method === "GET")).toBe(true);
    expect(recorder.requests.every((request) => !request.headers.has("authorization"))).toBe(true);
  });

  it("omits undefined public query values and credentials when no token exists", async () => {
    const recorder = recordedFetch(
      json(board),
      json(feed),
      json(detail),
      json(receipt),
      json(earn),
    );
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch });
    await client.board();
    await client.feed();
    await client.publicTask(ID);
    await client.receipt(ESCROW);
    await client.earn();
    expect(recorder.requests.map((request) => request.url)).toEqual([
      "https://tasks.example/api/board",
      "https://tasks.example/api/board/feed",
      `https://tasks.example/api/tasks/${ID}`,
      `https://tasks.example/api/receipts/${ESCROW}`,
      "https://tasks.example/api/earn",
    ]);
    expect(recorder.requests.every((request) => !request.headers.has("authorization"))).toBe(true);
  });

  it("accepts additive response fields, including inside a badge", async () => {
    const recorder = recordedFetch(
      json({
        ...board,
        future: true,
        cards: [
          { ...card, future: true, poster: { ...card.poster, badge: { ...badge, future: true } } },
        ],
      }),
    );
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).board(),
    ).resolves.toMatchObject({
      future: true,
      cards: [{ future: true, poster: { badge: { future: true } } }],
    });
  });

  it.each([
    ["board", { ...board, numbers: undefined }],
    ["feed", { ...feed, rows: [{ ...row, actor: undefined }] }],
    ["publicTask", { ...detail, briefFull: undefined }],
    ["receipt", { ...receipt, allocations: undefined }],
    ["earn", { ...earn, topEarners: undefined }],
  ] as const)("rejects a %s response missing a required field", async (method, response) => {
    const client = createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recordedFetch(json(response)).fetch,
    });
    const promise =
      method === "publicTask"
        ? client.publicTask(ID)
        : method === "receipt"
          ? client.receipt(ESCROW)
          : client[method]();
    await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["publicTask", "receipt"] as const)(
    "maps a non-JSON 404 from %s to null",
    async (method) => {
      const client = createTasksClient({
        baseUrl: "https://tasks.example",
        fetch: recordedFetch(new Response("missing", { status: 404 })).fetch,
      });
      await expect(
        method === "publicTask" ? client.publicTask(ID) : client.receipt(ESCROW),
      ).resolves.toBeNull();
    },
  );

  it("does not special-case readiness or other HTTP failures", async () => {
    const first = recordedFetch(
      json({ error: { code: "starting", message: "not ready" } }, { status: 503 }),
    );
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: first.fetch }).publicTask(
        "readiness",
      ),
    ).rejects.toMatchObject({ code: "http", status: 503, serverCode: "starting" });
    const second = recordedFetch(new Response("down", { status: 500, statusText: "Down" }));
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: second.fetch }).board(),
    ).rejects.toMatchObject({ code: "http", status: 500 });
  });

  it.each(["board", "feed", "earn"] as const)(
    "keeps a non-JSON 404 from %s as an HTTP error",
    async (method) => {
      const client = createTasksClient({
        baseUrl: "https://tasks.example",
        fetch: recordedFetch(new Response("missing", { status: 404 })).fetch,
      });
      await expect(client[method]()).rejects.toMatchObject({ code: "http", status: 404 });
    },
  );
});

describe("tasks client events", () => {
  it("encodes queries, omits undefined values, keeps bearer auth, and parses events", async () => {
    const recorder = recordedFetch(json(events), json(events));
    const client = createTasksClient({
      baseUrl: "https://tasks.example",
      token: "secret",
      fetch: recorder.fetch,
    });
    await expect(client.events("id /?#", { after: 6, wait: 0 })).resolves.toEqual(events);
    await client.events(ID, {});
    expect(recorder.requests.map((request) => request.url)).toEqual([
      "https://tasks.example/v1/work-orders/id%20%2F%3F%23/events?after=6&wait=0",
      `https://tasks.example/v1/work-orders/${ID}/events`,
    ]);
    expect(
      recorder.requests.every(
        (request) => request.headers.get("authorization") === "Bearer secret",
      ),
    ).toBe(true);
  });

  it.each([{ after: -1 }, { after: 1.5 }, { wait: 0.5 }, { wait: Number.MAX_SAFE_INTEGER + 1 }])(
    "rejects invalid event query %# without fetching",
    async (input) => {
      const fetch = vi.fn();
      await expect(
        createTasksClient({ baseUrl: "https://tasks.example", fetch }).events(ID, input),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects an events response missing a required field", async () => {
    const recorder = recordedFetch(
      json({ events: [{ ...events.events[0], payload: undefined }], nextAfter: 7 }),
    );
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).events(ID),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("accepts unknown event types and additive event fields", async () => {
    const response = {
      events: [{ ...events.events[0], type: "future.event", future: { nested: true } }],
      nextAfter: 7,
      future: true,
    };
    await expect(
      createTasksClient({
        baseUrl: "https://tasks.example",
        fetch: recordedFetch(json(response)).fetch,
      }).events(ID),
    ).resolves.toEqual(response);
  });

  it("keeps an events 404 as an HTTP error", async () => {
    const client = createTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recordedFetch(new Response("missing", { status: 404 })).fetch,
    });
    await expect(client.events(ID)).rejects.toMatchObject({ code: "http", status: 404 });
  });

  it.each([
    [undefined, 35_000],
    [1_000, 35_000],
    [45_000, 45_000],
  ] as const)("uses the wait-25 timeout floor (configured %s)", async (timeoutMs, expected) => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
    );
    const pending = createTasksClient({
      baseUrl: "https://tasks.example",
      fetch,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }).events(ID, { wait: 25 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps wait before calculating the timeout floor", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
    );
    const pending = createTasksClient({
      baseUrl: "https://tasks.example",
      fetch,
      timeoutMs: 1_000,
    }).events(ID, { wait: 99 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps caller abort to network and cleans its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
    );
    const pending = createTasksClient({ baseUrl: "https://tasks.example", fetch }).events(
      ID,
      {},
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "network" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("tasks client submissions", () => {
  it("submit preserves the signed payload and sends the mutation key", async () => {
    const recorder = recordedFetch(json({ proposal }));
    const result = await createTasksClient({
      baseUrl: "https://tasks.example",
      token: "secret",
      fetch: recorder.fetch,
    }).submit(ID, submissionInput(), { idempotencyKey: KEY });
    expect(result).toEqual({ proposal });
    expect([recorder.requests[0]!.method, recorder.requests[0]!.url]).toEqual([
      "POST",
      `https://tasks.example/v1/work-orders/${ID}/proposals`,
    ]);
    expect(recorder.requests[0]!.headers.get("idempotency-key")).toBe(KEY);
    expect(await recorder.requests[0]!.clone().json()).toEqual(submissionInput());
  });

  it("preserves signed values and does not mutate submit input", async () => {
    const input = submissionInput();
    input.signedPayload.providerAddress = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
    const terms = input.signedPayload.milestones[0]!;
    delete terms.acceptanceWindowSeconds;
    const before = structuredClone(input);
    const recorder = recordedFetch(json({ proposal }));
    await createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).submit(
      ID,
      input,
      { idempotencyKey: KEY },
    );
    expect(input).toEqual(before);
    expect(await recorder.requests[0]!.clone().json()).toEqual(before);
  });

  it("transmits the exact payload covered by the caller's signature", async () => {
    const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const unsigned = submissionInput();
    unsigned.signedPayload.providerAddress = account.address.toLowerCase();
    const signature = await account.signMessage({
      message: canonicalJson(unsigned.signedPayload),
    });
    const submission = { ...unsigned, signature } satisfies SubmitInput;
    const fetch = vi.fn(async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const request =
        requestInput instanceof Request && init === undefined
          ? requestInput
          : new Request(requestInput, init);
      const body = (await request.json()) as SubmitInput;
      expect(body.signedPayload).toEqual(submission.signedPayload);
      await expect(
        verifyMessage({
          address: account.address,
          message: canonicalJson(body.signedPayload),
          signature: body.signature as `0x${string}`,
        }),
      ).resolves.toBe(true);
      return json({
        proposal: {
          ...proposal,
          providerAddress: account.address,
          signedPayload: body.signedPayload,
          signature: body.signature,
        },
      });
    });

    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).submit(ID, submission, {
        idempotencyKey: KEY,
      }),
    ).resolves.toMatchObject({ proposal: { signature } });
  });

  it("requires submission kind at the typed and runtime boundary without fetching", async () => {
    const fetch = vi.fn();
    const original = submissionInput();
    const submission = {
      ...original,
      signedPayload: { ...original.signedPayload, kind: undefined },
    };
    // @ts-expect-error SubmitInput requires the signed submission discriminator.
    const compileContract: SubmitInput = submission;

    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).submit(ID, compileContract, {
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a mismatched submission kind without fetching", async () => {
    const fetch = vi.fn();
    const original = submissionInput();
    const submission = {
      ...original,
      signedPayload: { ...original.signedPayload, kind: "proposal" },
    } as unknown as SubmitInput;

    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).submit(ID, submission, {
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an uppercase HTTPS scheme in submission proof", async () => {
    const input = submissionInput();
    input.signedPayload.proof = [{ kind: "url", value: "HTTPS://EXAMPLE.COM/work" }];
    const recorder = recordedFetch(json({ proposal }));
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).submit(
        ID,
        input,
        { idempotencyKey: KEY },
      ),
    ).resolves.toEqual({ proposal });
  });

  it("rejects a submission response whose signed payload omits proof", async () => {
    const signedPayload = { ...proposal.signedPayload, proof: undefined };
    const recorder = recordedFetch(json({ proposal: { ...proposal, signedPayload } }));
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).submit(
        ID,
        submissionInput(),
        { idempotencyKey: KEY },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [{ kind: "url", value: "http://example.com" }],
    [{ kind: "url", value: "not a url" }],
    [{ kind: "file", value: "AB".repeat(32) }],
    [{ kind: "file", value: "ab" }],
  ])("rejects invalid submission proof %# without fetching", async (proof) => {
    const fetch = vi.fn();
    const original = submissionInput();
    const input = {
      ...original,
      signedPayload: { ...original.signedPayload, proof },
    } as unknown as SubmitInput;
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).submit(ID, input, {
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a proof array for submit without fetching", async () => {
    const fetch = vi.fn();
    const original = submissionInput();
    const input = {
      ...original,
      signedPayload: { ...original.signedPayload, proof: undefined },
    };
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).submit(
        ID,
        input as unknown as SubmitInput,
        {
          idempotencyKey: KEY,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an undefined submit input as invalid_input without fetching", async () => {
    const fetch = vi.fn();
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).submit(
        ID,
        // @ts-expect-error Exercises the runtime boundary for an untyped caller.
        undefined,
        {
          idempotencyKey: KEY,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the legacy proposal body exact and accepts explicit proposal kind", async () => {
    const legacy = {
      signedPayload: {
        version: "work-proposal-v1" as const,
        workOrderId: ID,
        providerAddress: ADDRESS,
        pricingModel: "fixed" as const,
        milestones: [milestone()],
      },
      signature: SIGNATURE,
    };
    const recorder = recordedFetch(
      json({ proposal: { ...proposal, signedPayload: legacy.signedPayload } }),
      json({
        proposal: { ...proposal, signedPayload: { ...legacy.signedPayload, kind: "proposal" } },
      }),
    );
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch });
    await client.propose(ID, legacy, { idempotencyKey: KEY });
    await client.propose(
      ID,
      { ...legacy, signedPayload: { ...legacy.signedPayload, kind: "proposal" } },
      { idempotencyKey: KEY },
    );
    expect(await recorder.requests[0]!.clone().json()).toEqual(legacy);
    expect(await recorder.requests[1]!.clone().json()).toEqual({
      ...legacy,
      signedPayload: { ...legacy.signedPayload, kind: "proposal" },
    });
  });

  it("propose supports a valid submission and rejects invalid submission proof", async () => {
    const recorder = recordedFetch(json({ proposal }));
    const client = createTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch });
    await expect(
      client.propose(
        ID,
        {
          ...submissionInput(),
          signedPayload: { ...submissionInput().signedPayload, kind: "submission" },
        },
        { idempotencyKey: KEY },
      ),
    ).resolves.toEqual({ proposal });
    const fetch = vi.fn();
    const invalid = {
      ...submissionInput(),
      signedPayload: {
        ...submissionInput().signedPayload,
        kind: "submission" as const,
        proof: [{ kind: "url" as const, value: "ftp://example.com" }],
      },
    };
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).propose(ID, invalid, {
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects proposal submissions without proof before fetching", async () => {
    const fetch = vi.fn();
    const original = submissionInput();
    await expect(
      createTasksClient({ baseUrl: "https://tasks.example", fetch }).propose(
        ID,
        {
          ...original,
          signedPayload: { ...original.signedPayload, kind: "submission", proof: undefined },
        },
        { idempotencyKey: KEY },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
