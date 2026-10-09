import { TasksChainError } from "./chain-port.js";
import { TasksClientError } from "./client.js";

/** Local diagnostics may cross the CLI/MCP boundary. RPC/server errors never retain their original cause. */
export class TasksValidationError extends Error {}

export function safeTasksChainError(
  cause: unknown,
  broadcast: boolean,
  authorizationExposed: boolean,
  txHash?: `0x${string}`,
): TasksChainError {
  txHash ??= cause instanceof TasksChainError ? cause.transactionHash : undefined;
  let message = "Task chain operation failed.";
  if (cause instanceof TasksValidationError || cause instanceof TasksChainError)
    message = cause.message;
  else if (cause instanceof TasksClientError)
    message = `Tasks service request failed${cause.status === undefined ? "" : ` (status ${cause.status})`}.`;
  else if (cause instanceof Error) {
    const short =
      "shortMessage" in cause && typeof cause.shortMessage === "string"
        ? cause.shortMessage
        : undefined;
    let statusCode: number | undefined;
    const seen = new Set<Error>();
    let source: unknown = cause;
    while (source instanceof Error && seen.size < 8 && !seen.has(source)) {
      seen.add(source);
      if ("status" in source && typeof source.status === "number") {
        statusCode = source.status;
        break;
      }
      source = source.cause;
    }
    const status = statusCode === undefined ? "" : ` (status ${statusCode})`;
    const name = /^[A-Za-z][A-Za-z0-9]*$/u.test(cause.name) ? cause.name : "Error";
    message = `${name}${status}: ${short?.split("\n")[0] ?? "Task chain operation failed."}`;
  }
  // Defense in depth for shortMessage: never serialize calldata, authorizations, or request JSON.
  message = message
    .replace(/ Transaction 0x[0-9a-fA-F]{64}\.$/u, "")
    .split("\n")[0]!
    .replace(/0x[0-9a-fA-F]{8,}/gu, "[redacted]")
    .replace(/\{.*$/u, "[redacted]");
  if (txHash) message += ` Transaction ${txHash}.`;
  return new TasksChainError(
    message,
    broadcast || (cause instanceof TasksChainError && cause.broadcast),
    {
      ...(txHash ? { transactionHash: txHash } : {}),
      authorizationExposed:
        authorizationExposed || (cause instanceof TasksChainError && cause.authorizationExposed),
    },
  );
}
