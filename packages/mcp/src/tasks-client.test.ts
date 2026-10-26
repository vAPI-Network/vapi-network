import { describe, expect, it, vi } from "vitest";
import { createHostedTasksClient } from "./tasks-client.js";
import { v2Terms, v2Lifecycle, v2NextAction } from "../../core/src/tasks/fixtures/tasks-v2.js";
const ID = "11111111-1111-4111-8111-111111111111";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-10-08T12:00:00.000Z";
const privateOrder = {
  version: "work-order-view-v1",
  id: ID,
  state: "open",
  title: "Build a page",
  description: "Build a working page",
  policyFamily: "general-digital",
  listingDeliveryTimeSeconds: null,
  clientAddress: "0x1111111111111111111111111111111111111111",
  invitedProviderAddress: null,
  acceptedProposalId: null,
  threadId: null,
  role: "client",
  canFinalize: false,
  proposals: [],
  milestones: [],
  events: [],
  review: null,
  publishedAt: NOW,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
function json(value: unknown, init?: ResponseInit) {
  return Response.json(value, init);
}
function recordedFetch(...responses: Response[]) {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("No recorded response");
    return response;
  });
  return { fetch, requests };
}
async function requestBody(request: Request): Promise<unknown> {
  return request.clone().json();
}

describe("hosted Tasks views and preparation", () => {
  it("transports canonical lifecycle and next action through the hosted read model", async () => {
    const value = {
      workOrder: { ...privateOrder, terms: v2Terms },
      lifecycle: v2Lifecycle,
      nextAction: v2NextAction,
    };
    const recorder = recordedFetch(
      json({ jsonrpc: "2.0", id: 1, result: { structuredContent: value } }),
    );
    const result = await createHostedTasksClient({
      baseUrl: "https://tasks.example",
      token: "token",
      fetch: recorder.fetch,
    }).show(ID);
    expect(result).toEqual(value);
    expect(await requestBody(recorder.requests[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tasks.show", arguments: { workOrderId: ID } },
    });
    expect(recorder.requests[0]!.headers.get("authorization")).toBe("Bearer token");
  });
  it("preserves the created task and the funding error from T7", async () => {
    const { v2FundingUnavailable } = await import("../../core/src/tasks/fixtures/tasks-v2.js");
    const response = { task: { workOrder: privateOrder }, funding: v2FundingUnavailable };
    const recorder = recordedFetch(
      json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(response) }] },
      }),
    );
    const result = await createHostedTasksClient({
      baseUrl: "https://tasks.example",
      fetch: recorder.fetch,
    }).post(
      {
        title: "Build a page",
        description: "Build a working page",
        policyFamily: "general-digital",
        shape: "task",
        fund: true,
      },
      { idempotencyKey: KEY },
    );
    expect(result).toEqual(response);
    expect(await requestBody(recorder.requests[0]!)).toMatchObject({
      params: { name: "tasks.post", arguments: { shape: "task", fund: true, idempotencyKey: KEY } },
    });
  });
});
describe("hosted Tasks error parity", () => {
  it.each([
    { status: 403, code: "insufficient_scope", message: "Task scope is required" },
    { status: 404, message: "Work order not found" },
    { status: 409, code: "busy", message: "Try again later", retryAfter: "2" },
  ])("preserves structured hosted status $status and error codes", async (error) => {
    const recorder = recordedFetch(
      json({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: JSON.stringify(error) }] },
      }),
    );
    await expect(
      createHostedTasksClient({ baseUrl: "https://tasks.example", fetch: recorder.fetch }).show(ID),
    ).rejects.toMatchObject({
      status: error.status,
      serverCode: error.code,
      message: error.message,
      retryAfter: "retryAfter" in error ? error.retryAfter : undefined,
    });
  });
});
