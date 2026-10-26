import { z } from "zod";
import { createPublicFetch } from "@vapi-network/core";
import {
  createTasksClient,
  TasksClientError,
  taskReadResponseSchema,
  taskPostResponseSchema,
  type TasksClient,
  type TasksClientOptions,
  type TasksRequestOptions,
} from "@vapi-network/core/tasks";

/** Enrich the HTTP SDK with the hosted canonical views and unsigned post intent.
 * MCP belongs to this interface package; signing and policy remain in core.
 */
export function createHostedTasksClient(options: TasksClientOptions): TasksClient {
  const client = createTasksClient(options);
  const baseUrl = new URL(options.baseUrl).href.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? createPublicFetch({ allowPrivateNetwork: false });
  async function request<T>(
    path: string,
    method: "POST",
    schema: z.ZodType<T>,
    call: TasksRequestOptions & { accept: string; body: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
    try {
      const headers = new Headers({ Accept: call.accept, "Content-Type": "application/json" });
      if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
      if (call.idempotencyKey !== undefined) {
        if (!z.uuid().safeParse(call.idempotencyKey).success)
          throw new TasksClientError("invalid_input", "Idempotency-Key must be a UUID.");
        headers.set("Idempotency-Key", call.idempotencyKey);
      }
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: JSON.stringify(call.body),
        signal,
        redirect: "manual",
      });
      const raw = await response.text();
      signal.throwIfAborted();
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        /* HTTP errors can have plain text bodies. */
      }
      if (!response.ok) {
        const parsed = z
          .object({
            error: z
              .union([
                z.string(),
                z.object({ code: z.string().optional(), message: z.string().optional() }),
              ])
              .optional(),
            code: z.string().optional(),
            message: z.string().optional(),
          })
          .safeParse(value);
        const server = parsed.success ? parsed.data : undefined;
        const nested = typeof server?.error === "object" ? server.error : undefined;
        throw new TasksClientError(
          "http",
          nested?.message ??
            (typeof server?.error === "string" ? server.error : server?.message) ??
            response.statusText ??
            `HTTP ${response.status}`,
          response.status,
          nested?.code ?? server?.code,
          response.headers.get("Retry-After") ?? undefined,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw new TasksClientError("invalid_response", "Invalid hosted Tasks response.");
      return parsed.data;
    } catch (error) {
      if (error instanceof TasksClientError) throw error;
      if (timeout.aborted) throw new TasksClientError("timeout", "The task request timed out.");
      throw new TasksClientError("network", "The hosted task request failed.");
    }
  }
  // The hosted read model and one-call post response are exposed through MCP.
  // Its stateless HTTP transport returns JSON; no bearer or signing material is
  // forwarded to another origin, and every request uses the same network guard.
  async function hosted<T>(
    name: string,
    args: object,
    schema: z.ZodType<T>,
    call: TasksRequestOptions = {},
  ): Promise<T> {
    const envelope = await request(
      "/mcp",
      "POST",
      z.object({
        result: z
          .object({
            structuredContent: z.unknown().optional(),
            content: z
              .array(z.object({ type: z.string(), text: z.string().optional() }))
              .optional(),
            isError: z.boolean().optional(),
          })
          .optional(),
        error: z.object({ code: z.number(), message: z.string() }).optional(),
      }),
      {
        ...call,
        accept: "application/json, text/event-stream",
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      },
    );
    const result = envelope.result;
    if (envelope.error || !result || result.isError) {
      const message =
        envelope.error?.message ??
        result?.content?.find((item) => item.type === "text")?.text ??
        `${name} failed.`;
      let serverCode: string | undefined;
      let serverMessage = message;
      let serverStatus: number | undefined;
      let retryAfter: string | undefined;
      try {
        const parsed = z
          .object({
            code: z.string().optional(),
            message: z.string(),
            status: z.number().int().min(400).max(599).optional(),
            retryAfter: z.string().optional(),
          })
          .safeParse(JSON.parse(message));
        if (parsed.success) {
          serverCode = parsed.data.code;
          serverMessage = parsed.data.message;
          serverStatus = parsed.data.status;
          retryAfter = parsed.data.retryAfter;
        }
      } catch {
        /* Plain-text hosted errors remain useful diagnostics. */
      }
      const status =
        serverStatus ??
        (serverCode === "insufficient_scope"
          ? 403
          : serverCode === "not_found" || serverCode === "work_order_not_found"
            ? 404
            : 400);
      throw new TasksClientError("http", serverMessage, status, serverCode, retryAfter);
    }
    let value = result.structuredContent;
    if (value === undefined) {
      try {
        value = JSON.parse(result.content?.find((item) => item.type === "text")?.text ?? "");
      } catch {
        throw new TasksClientError("invalid_response", `Invalid ${name} response.`);
      }
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new TasksClientError(
        "invalid_response",
        `Invalid ${name} response at ${parsed.error.issues[0]?.path.join(".") || "<root>"}.`,
      );
    return parsed.data;
  }

  return {
    ...client,
    show: (id, call = {}) =>
      hosted("tasks.show", { workOrderId: id }, taskReadResponseSchema, call),
    post: (order, call) =>
      hosted(
        "tasks.post",
        { ...order, idempotencyKey: call.idempotencyKey },
        taskPostResponseSchema,
        call,
      ),
  };
}
