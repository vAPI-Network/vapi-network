import { z } from "zod";

import { createPublicFetch } from "../net-guard.js";
import {
  boardQuerySchema,
  eventsQuerySchema,
  feedQuerySchema,
  proposeInputSchema,
  submitInputSchema,
  tasksResponseSchemas,
} from "./types.js";
import type {
  AcceptProposalInput,
  BoardQuery,
  CreateOrderInput,
  CreateUploadInput,
  DeliverEscrowInput,
  DisputeEscrowInput,
  EventsQuery,
  FeedQuery,
  FinalizeUploadResponse,
  FundEscrowInput,
  ListMessagesQuery,
  ListOrdersQuery,
  ProposeInput,
  ProposeScopeInput,
  SendMessageInput,
  SignScopeInput,
  SubmitInput,
  UploadFileInput,
} from "./types.js";

const publicFetch = createPublicFetch({ allowPrivateNetwork: false });

export type TasksClientOptions = {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type TasksRequestOptions = { signal?: AbortSignal };

/** Retain the same key when retrying the same mutation. The client never retries automatically. */
export type TasksMutationOptions = TasksRequestOptions & { idempotencyKey: string };

export class TasksClientError extends Error {
  constructor(
    readonly code: "invalid_input" | "http" | "invalid_response" | "network" | "timeout",
    message: string,
    readonly status?: number,
    readonly serverCode?: string,
  ) {
    super(message);
    this.name = "TasksClientError";
  }
}

type RequestOptions = TasksRequestOptions & {
  idempotencyKey?: string;
  body?: unknown;
  upload?: { bytes: Uint8Array; contentType: string };
  publicRead?: boolean;
  notFoundAsNull?: boolean;
  timeoutFloorMs?: number;
};

const serverErrorSchema = z.object({
  error: z
    .union([
      z.string(),
      z.object({
        code: z.string().optional().catch(undefined),
        message: z.string().optional().catch(undefined),
      }),
    ])
    .optional()
    .catch(undefined),
  code: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
});

/** HTTP transport for task routes; signing happens outside this client. */
export function createTasksClient(options: TasksClientOptions): TasksClient {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      /[?#]/u.test(options.baseUrl)
    ) {
      throw new Error("Invalid base URL");
    }
  } catch {
    throw new TasksClientError(
      "invalid_input",
      "baseUrl must be an HTTP(S) URL without credentials, query, or hash.",
    );
  }
  const baseUrl = base.href.replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TasksClientError(
      "invalid_input",
      "timeoutMs must be a positive integer no greater than 2147483647.",
    );
  }
  const fetchImpl = options.fetch ?? publicFetch;

  // Every API call and storage PUT shares transport, timeout, and error handling.
  async function request<T>(
    path: string,
    method: "GET" | "POST" | "PUT",
    schema: z.ZodType<T>,
    call: RequestOptions = {},
  ): Promise<T> {
    let url: URL;
    let headers: Headers;
    let body: BodyInit | undefined;
    try {
      url = new URL(call.upload ? path : `${baseUrl}${path}`);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new TasksClientError(
          "invalid_response",
          "The upload URL must use HTTP(S) without credentials.",
        );
      }
      headers = new Headers({ Accept: "application/json" });
      // Presigned uploads never receive the bearer, even if storage shares the API origin.
      if (
        !call.upload &&
        !call.publicRead &&
        options.token !== undefined &&
        url.origin === base.origin
      ) {
        headers.set("Authorization", `Bearer ${options.token}`);
      }
      if (call.idempotencyKey !== undefined) {
        if (!z.uuid().safeParse(call.idempotencyKey).success) {
          throw new TasksClientError("invalid_input", "Idempotency-Key must be a UUID.");
        }
        headers.set("Idempotency-Key", call.idempotencyKey);
      }
      if (call.upload) {
        headers.set("Content-Type", call.upload.contentType);
        headers.set("x-upsert", "false");
        body = Uint8Array.from(call.upload.bytes);
      } else if (call.body !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(call.body);
      }
    } catch (error) {
      if (error instanceof TasksClientError) throw error;
      throw new TasksClientError("invalid_input", "The request URL, headers, or body are invalid.");
    }

    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("Request timed out", "TimeoutError")),
      Math.max(timeoutMs, call.timeoutFloorMs ?? 0),
    );
    const signal = call.signal ? AbortSignal.any([call.signal, timeout.signal]) : timeout.signal;
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(url, { method, headers, body, signal, redirect: "manual" });
      signal.throwIfAborted();
      const notFound = call.notFoundAsNull && response.status === 404;
      if (!response.ok && !notFound) {
        const raw = await response.text();
        signal.throwIfAborted();
        let errorBody: unknown;
        try {
          errorBody = JSON.parse(raw) as unknown;
        } catch {
          /* Use the status text below. */
        }
        const parsed = serverErrorSchema.safeParse(errorBody);
        const server = parsed.success ? parsed.data : undefined;
        const nested = typeof server?.error === "object" ? server.error : undefined;
        const message =
          (typeof server?.error === "string" ? server.error : nested?.message) ||
          server?.message ||
          response.statusText ||
          `HTTP ${response.status}`;
        throw new TasksClientError("http", message, response.status, nested?.code ?? server?.code);
      }
      let json: unknown;
      if (notFound) {
        await response.body?.cancel();
        json = null;
      } else if (!call.upload) {
        const raw = await response.text();
        signal.throwIfAborted();
        try {
          json = JSON.parse(raw) as unknown;
        } catch {
          throw new TasksClientError(
            "invalid_response",
            "The task response is not valid JSON at <root>.",
            response.status,
          );
        }
      } else {
        await response.body?.cancel();
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        let issue = parsed.error.issues[0];
        // Show the useful leaf path when a public/private response union fails.
        while (issue?.code === "invalid_union" && issue.errors.length > 0) {
          const branch = issue.errors.reduce((best, errors) =>
            errors.length < best.length ? errors : best,
          );
          issue = branch[0];
        }
        const path = issue?.path.join(".") || "<root>";
        throw new TasksClientError(
          "invalid_response",
          `Invalid task response at ${path}: ${issue?.message ?? "Invalid value"}`,
          response.status,
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof TasksClientError) throw error;
      if (timeout.signal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
        throw new TasksClientError("timeout", "The task request timed out.");
      }
      throw new TasksClientError(
        "network",
        error instanceof Error ? error.message : "The task request failed.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function segment(id: string): string {
    try {
      if (!id || id === "." || id === "..") throw new Error("Invalid path parameter");
      return encodeURIComponent(id);
    } catch {
      throw new TasksClientError("invalid_input", "A valid path parameter is required.");
    }
  }

  function query(values: object): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return params.size ? `?${params}` : "";
  }

  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TasksClientError(
        "invalid_input",
        `Invalid task input at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? "Invalid value"}`,
      );
    }
    return parsed.data;
  }

  const client = {
    /** Use scope: "public" for anonymous reads; the server defaults to "private".
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    listOrders(input: ListOrdersQuery = {}, call: TasksRequestOptions = {}) {
      return request(
        `/v1/work-orders${query(input)}`,
        "GET",
        tasksResponseSchemas.listOrders,
        call,
      );
    },
    /** Anonymous reads return the public projection; private reads require a session.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    getOrder(id: string, call: TasksRequestOptions = {}) {
      return request(`/v1/work-orders/${segment(id)}`, "GET", tasksResponseSchemas.getOrder, call);
    },
    /** Accepts an OAuth bearer token or browser session today. */
    createOrder(input: CreateOrderInput, call: TasksMutationOptions) {
      return request("/v1/work-orders", "POST", tasksResponseSchemas.createOrder, {
        ...call,
        body: input,
      });
    },
    /** Transports an already signed proposal; accepts an OAuth bearer token or session today. */
    async propose(id: string, proposal: ProposeInput, call: TasksMutationOptions) {
      input(proposeInputSchema, proposal);
      return request(
        `/v1/work-orders/${segment(id)}/proposals`,
        "POST",
        tasksResponseSchemas.propose,
        // Preserve the signed bytes' values; schema defaults/transforms must not change them.
        { ...call, body: proposal },
      );
    },
    /** (plan 032 Lane B; not on the server yet) */
    async submit(id: string, submission: SubmitInput, call: TasksMutationOptions) {
      input(submitInputSchema, submission);
      return request(
        `/v1/work-orders/${segment(id)}/proposals`,
        "POST",
        tasksResponseSchemas.submit,
        // Preserve the exact payload the caller signed.
        { ...call, body: submission },
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    acceptProposal(id: string, input: AcceptProposalInput, call: TasksMutationOptions) {
      return request(
        `/v1/work-orders/${segment(id)}/accept`,
        "POST",
        tasksResponseSchemas.acceptProposal,
        { ...call, body: input },
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    getScopes(id: string, call: TasksRequestOptions = {}) {
      return request(
        `/v1/work-orders/${segment(id)}/scopes`,
        "GET",
        tasksResponseSchemas.getScopes,
        call,
      );
    },
    /** Proposes an already signed scope; acceptance is a separate signScope call.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    proposeScope(id: string, input: ProposeScopeInput, call: TasksMutationOptions) {
      return request(
        `/v1/work-orders/${segment(id)}/scopes`,
        "POST",
        tasksResponseSchemas.proposeScope,
        { ...call, body: input },
      );
    },
    /** Accepts a scope using the supplied signature; no signing occurs here.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    signScope(scopeId: string, input: SignScopeInput, call: TasksMutationOptions) {
      return request(`/v1/scopes/${segment(scopeId)}`, "POST", tasksResponseSchemas.signScope, {
        ...call,
        body: { ...input, action: "accept" },
      });
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    listMessages(id: string, input: ListMessagesQuery = {}, call: TasksRequestOptions = {}) {
      return request(
        `/v1/work-orders/${segment(id)}/messages${query(input)}`,
        "GET",
        tasksResponseSchemas.listMessages,
        call,
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    sendMessage(id: string, input: SendMessageInput, call: TasksMutationOptions) {
      return request(
        `/v1/work-orders/${segment(id)}/messages`,
        "POST",
        tasksResponseSchemas.sendMessage,
        { ...call, body: input },
      );
    },
    /** Prepares a transaction operation.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    createEscrow(id: string, call: TasksMutationOptions) {
      return request(
        `/v1/work-orders/${segment(id)}/escrow`,
        "POST",
        tasksResponseSchemas.createEscrow,
        { ...call, body: {} },
      );
    },
    /** Prepares funding with an already signed authorization when ERC-3009 is enabled.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    fundEscrow(id: string, input: FundEscrowInput, call: TasksMutationOptions) {
      return request(`/v1/escrows/${segment(id)}/fund`, "POST", tasksResponseSchemas.fundEscrow, {
        ...call,
        body: input,
      });
    },
    /** Prepares delivery from finalized files and a note before chain broadcast.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    deliverEscrow(id: string, input: DeliverEscrowInput, call: TasksMutationOptions) {
      return request(
        `/v1/escrows/${segment(id)}/deliver`,
        "POST",
        tasksResponseSchemas.deliverEscrow,
        { ...call, body: input },
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    releaseEscrow(id: string, call: TasksMutationOptions) {
      return request(
        `/v1/escrows/${segment(id)}/release`,
        "POST",
        tasksResponseSchemas.releaseEscrow,
        { ...call, body: {} },
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    refundEscrow(id: string, call: TasksMutationOptions) {
      return request(
        `/v1/escrows/${segment(id)}/refund`,
        "POST",
        tasksResponseSchemas.refundEscrow,
        { ...call, body: {} },
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    disputeEscrow(id: string, input: DisputeEscrowInput, call: TasksMutationOptions) {
      return request(
        `/v1/escrows/${segment(id)}/dispute`,
        "POST",
        tasksResponseSchemas.disputeEscrow,
        { ...call, body: input },
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    chainState(id: string, call: TasksRequestOptions = {}) {
      return request(
        `/v1/work-orders/${segment(id)}/chain-state`,
        "GET",
        tasksResponseSchemas.chainState,
        call,
      );
    },
    /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
    createUpload(input: CreateUploadInput, call: TasksRequestOptions = {}) {
      return request("/v1/files", "POST", tasksResponseSchemas.createUpload, {
        ...call,
        body: input,
      });
    },
    /** The server computes sha256 when finalizing the stored bytes.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    finalizeUpload(id: string, call: TasksRequestOptions = {}) {
      return request(
        `/v1/files/${segment(id)}/finalize`,
        "POST",
        tasksResponseSchemas.finalizeUpload,
        call,
      );
    },
    /** Defaults to a delivery file with text/plain content type.
     * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
     */
    async uploadFile(
      input: UploadFileInput,
      call: TasksRequestOptions = {},
    ): Promise<FinalizeUploadResponse> {
      const bytes = Uint8Array.from(input.bytes);
      const contentType = input.contentType ?? "text/plain";
      const created = await client.createUpload(
        {
          purpose: input.purpose ?? "delivery",
          fileName: input.fileName,
          mimeType: contentType,
          sizeBytes: bytes.byteLength,
        },
        call,
      );
      await request(created.uploadUrl, "PUT", z.void(), {
        ...call,
        upload: { bytes, contentType },
      });
      return client.finalizeUpload(created.file.id, call);
    },
    /** Public deployment probe at the canonical readiness path. */
    deployment(call: TasksRequestOptions = {}) {
      return request("/api/tasks/readiness", "GET", tasksResponseSchemas.deployment, call);
    },
    /** (plan 032 Lane B; not on the server yet) */
    async events(id: string, values: EventsQuery = {}, call: TasksRequestOptions = {}) {
      const params = input(eventsQuerySchema, values);
      return request(
        `/v1/work-orders/${segment(id)}/events${query(params)}`,
        "GET",
        tasksResponseSchemas.events,
        { ...call, timeoutFloorMs: ((params.wait ?? 0) + 10) * 1_000 },
      );
    },
    /** (plan 032 Lane B; not on the server yet) */
    async board(values: BoardQuery = {}, call: TasksRequestOptions = {}) {
      return request(
        `/api/board${query(input(boardQuerySchema, values))}`,
        "GET",
        tasksResponseSchemas.board,
        { ...call, publicRead: true },
      );
    },
    /** (plan 032 Lane B; not on the server yet) */
    async feed(values: FeedQuery = {}, call: TasksRequestOptions = {}) {
      return request(
        `/api/board/feed${query(input(feedQuerySchema, values))}`,
        "GET",
        tasksResponseSchemas.feed,
        { ...call, publicRead: true },
      );
    },
    /** (plan 032 Lane B; not on the server yet) */
    publicTask(id: string, call: TasksRequestOptions = {}) {
      return request(`/api/tasks/${segment(id)}`, "GET", tasksResponseSchemas.publicTask, {
        ...call,
        publicRead: true,
        notFoundAsNull: true,
      });
    },
    /** (plan 032 Lane B; not on the server yet) */
    receipt(escrow: string, call: TasksRequestOptions = {}) {
      return request(`/api/receipts/${segment(escrow)}`, "GET", tasksResponseSchemas.receipt, {
        ...call,
        publicRead: true,
        notFoundAsNull: true,
      });
    },
    /** (plan 032 Lane B; not on the server yet) */
    earn(call: TasksRequestOptions = {}) {
      return request("/api/earn", "GET", tasksResponseSchemas.earn, { ...call, publicRead: true });
    },
  };
  return client;
}

type TaskResponse<Method extends keyof typeof tasksResponseSchemas> = z.infer<
  (typeof tasksResponseSchemas)[Method]
>;

export type TasksClient = {
  /** Public scope is anonymous; the server defaults to private scope.
   * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
   */
  listOrders(
    input?: ListOrdersQuery,
    call?: TasksRequestOptions,
  ): Promise<TaskResponse<"listOrders">>;
  /** Anonymous reads return the public projection; private reads require a session.
   * Bearer access arrives with plan 032 Lane B6; the route needs a browser session today.
   */
  getOrder(id: string, call?: TasksRequestOptions): Promise<TaskResponse<"getOrder">>;
  createOrder(
    input: CreateOrderInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"createOrder">>;
  propose(
    id: string,
    input: ProposeInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"propose">>;
  /** (plan 032 Lane B; not on the server yet) */
  submit(
    id: string,
    input: SubmitInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"submit">>;
  /** (plan 032 Lane B; not on the server yet) */
  events(
    id: string,
    input?: EventsQuery,
    call?: TasksRequestOptions,
  ): Promise<TaskResponse<"events">>;
  /** (plan 032 Lane B; not on the server yet) */
  board(input?: BoardQuery, call?: TasksRequestOptions): Promise<TaskResponse<"board">>;
  /** (plan 032 Lane B; not on the server yet) */
  feed(input?: FeedQuery, call?: TasksRequestOptions): Promise<TaskResponse<"feed">>;
  /** (plan 032 Lane B; not on the server yet) */
  publicTask(id: string, call?: TasksRequestOptions): Promise<TaskResponse<"publicTask">>;
  /** (plan 032 Lane B; not on the server yet) */
  receipt(escrow: string, call?: TasksRequestOptions): Promise<TaskResponse<"receipt">>;
  /** (plan 032 Lane B; not on the server yet) */
  earn(call?: TasksRequestOptions): Promise<TaskResponse<"earn">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  acceptProposal(
    id: string,
    input: AcceptProposalInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"acceptProposal">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  getScopes(id: string, call?: TasksRequestOptions): Promise<TaskResponse<"getScopes">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  proposeScope(
    id: string,
    input: ProposeScopeInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"proposeScope">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  signScope(
    scopeId: string,
    input: SignScopeInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"signScope">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  listMessages(
    id: string,
    input?: ListMessagesQuery,
    call?: TasksRequestOptions,
  ): Promise<TaskResponse<"listMessages">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  sendMessage(
    id: string,
    input: SendMessageInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"sendMessage">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  createEscrow(id: string, call: TasksMutationOptions): Promise<TaskResponse<"createEscrow">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  fundEscrow(
    id: string,
    input: FundEscrowInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"fundEscrow">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  deliverEscrow(
    id: string,
    input: DeliverEscrowInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"deliverEscrow">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  releaseEscrow(id: string, call: TasksMutationOptions): Promise<TaskResponse<"releaseEscrow">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  refundEscrow(id: string, call: TasksMutationOptions): Promise<TaskResponse<"refundEscrow">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  disputeEscrow(
    id: string,
    input: DisputeEscrowInput,
    call: TasksMutationOptions,
  ): Promise<TaskResponse<"disputeEscrow">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  chainState(id: string, call?: TasksRequestOptions): Promise<TaskResponse<"chainState">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  createUpload(
    input: CreateUploadInput,
    call?: TasksRequestOptions,
  ): Promise<TaskResponse<"createUpload">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  finalizeUpload(id: string, call?: TasksRequestOptions): Promise<TaskResponse<"finalizeUpload">>;
  /** Bearer access arrives with plan 032 Lane B6; the route needs a browser session today. */
  uploadFile(input: UploadFileInput, call?: TasksRequestOptions): Promise<FinalizeUploadResponse>;
  deployment(call?: TasksRequestOptions): Promise<TaskResponse<"deployment">>;
};
