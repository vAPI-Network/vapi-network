import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { agentAccessToken, AgentLinkError } from "../agent-link.js";
import {
  agentProfileSchema,
  listAgentProfiles,
  type AgentProfileParser,
} from "../agent-profile.js";
import { DEFAULT_AUTO_RELEASE_BELOW_USD, DEFAULT_MAX_PER_TASK_USD } from "../config.js";
import type { SecretStore } from "../secret-store.js";
import { SpendCapError } from "../spend-policy.js";
import type { WalletName } from "../wallet-name.js";
import type { WalletStore } from "../wallet-store.js";
import { TasksChainUnavailableError, type TasksChain } from "./chain-port.js";
import { TasksClientError, type TasksClient } from "./client.js";
import type { PendingTransactions } from "./pending-transactions.js";
import { parseFeeBp, taskMoney, type TaskMoney } from "./money.js";
import {
  type EventsResponse,
  type GetOrderResponse,
  type ProposeInput,
  type UploadFileInput,
} from "./types.js";

export class TaskOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly manifestHash?: `0x${string}`,
  ) {
    super(message);
    this.name = "TaskOperationError";
  }
}

export class TaskInputError extends TaskOperationError {
  constructor(message: string) {
    super("invalid_input", message);
    this.name = "TaskInputError";
  }
}

export type TaskRoute = keyof TasksClient;
export const PENDING_SERVER_ROUTES: ReadonlySet<TaskRoute> = new Set([
  "board",
  "publicTask",
  "receipt",
  "events",
  "submit",
  "feed",
]);

export function isMissingTaskEntity(code: unknown, message: unknown): boolean {
  return (
    (typeof code === "string" && /^(?:task|work_order|receipt|order)_not_found$/iu.test(code)) ||
    (typeof message === "string" &&
      /\b(?:task|work order|order|receipt)\b.*\bnot found\b/iu.test(message))
  );
}

export function publicNotFoundFetch(fetchImpl: typeof fetch, baseUrl: string): typeof fetch {
  const base = baseUrl.replace(/\/+$/u, "");
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (
      response.status !== 404 ||
      ![`${base}/api/tasks/`, `${base}/api/receipts/`].some((prefix) => url.startsWith(prefix))
    )
      return response;
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      /* unmounted route may be HTML */
    }
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const nested =
      typeof record?.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : undefined;
    const code = nested?.code ?? record?.code;
    const message =
      typeof record?.error === "string" ? record.error : (nested?.message ?? record?.message);
    if (isMissingTaskEntity(code, message)) return response;
    await response.body?.cancel();
    throw new TasksClientError(
      "http",
      "The public task route is unavailable.",
      404,
      typeof code === "string" ? code : undefined,
    );
  };
}

export async function taskRequest<T>(
  verb: string,
  route: TaskRoute,
  operation: () => Promise<T>,
  options: { signInHint: string },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof TasksChainUnavailableError ||
      (error instanceof Error && "code" in error && error.code === "chain_unavailable")
    ) {
      const hash =
        typeof error === "object" &&
        error !== null &&
        "manifestHash" in error &&
        typeof error.manifestHash === "string"
          ? (error.manifestHash as `0x${string}`)
          : undefined;
      throw new TaskOperationError(
        "chain_unavailable",
        "An acting wallet is required for task chain operations.",
        hash,
      );
    }
    if (error instanceof TasksClientError) {
      if (error.code === "invalid_input") throw new TaskInputError(error.message);
      if (error.status === 403 && error.serverCode === "insufficient_scope") {
        throw new TaskOperationError(
          "insufficient_scope",
          options.signInHint.includes("auth.link")
            ? "This sign-in lacks Tasks access. Call auth.link again."
            : "This sign-in lacks Tasks access. Run vapi login again.",
        );
      }
      if (
        error.status === 404 &&
        PENDING_SERVER_ROUTES.has(route) &&
        !isMissingTaskEntity(error.serverCode, error.message)
      )
        throw new TaskOperationError(
          "not_available",
          `${verb} is not available on this server yet.`,
        );
      if (
        (error.status === 401 || error.status === 403) &&
        !["board", "publicTask", "receipt", "feed", "deployment"].includes(route)
      )
        throw new TaskOperationError(
          "not_signed_in",
          `${verb} needs sign-in. ${options.signInHint}`,
        );
      throw new TaskOperationError(error.serverCode ?? error.code, error.message);
    }
    throw error;
  }
}

export async function resolveTaskBearer(args: {
  secrets: SecretStore;
  wallets: WalletStore;
  wallet: WalletName;
  baseUrl: string;
  signInHint: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<string | undefined> {
  const link = args.wallets.entry(args.wallet)?.link;
  if (!link) return undefined;
  if (new URL(link.apiBase).origin !== new URL(args.baseUrl).origin)
    throw new TaskOperationError(
      "not_signed_in",
      `The acting wallet is linked to a different server. ${args.signInHint}`,
    );
  try {
    const token = await agentAccessToken({
      secrets: args.secrets,
      wallets: args.wallets,
      wallet: args.wallet,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      ...(args.now ? { now: args.now } : {}),
    });
    const current = args.wallets.entry(args.wallet)?.link;
    if (current?.clientId !== link.clientId || current.apiBase !== link.apiBase)
      throw new TaskOperationError(
        "not_signed_in",
        "The acting wallet's sign-in changed. Retry with its current server.",
      );
    return token;
  } catch (error) {
    if (error instanceof AgentLinkError && error.code === "not_linked") return undefined;
    throw error;
  }
}

export const TASK_LIMITS = {
  postDeadlineMinMs: 600000,
  proposalDurationMinMs: 600000,
  proposalDurationMaxMs: 7776000000,
  proposalDurationUnitMs: 1000,
  proposalNoteMin: 1,
  proposalNoteMax: 8000,
  titleMin: 3,
  titleMax: 120,
  briefMin: 10,
  briefMax: 8000,
  maxAwardsMin: 1,
  maxAwardsMax: 50,
  deliveryFilesMin: 1,
  deliveryFilesMax: 20,
  deliveryNoteMax: 32000,
  messageMin: 1,
  messageMax: 10000,
  searchTabs: ["trending", "new", "closing", "paid"],
  disputeEvidenceHash: /^0x[0-9a-fA-F]{64}$/u,
  uploadBytesMin: 1,
  uploadBytesMax: 50 * 1024 * 1024,
  watchIntervalMinMs: 1000,
} as const;

export function parseTaskDuration(text: string, now: Date): number {
  const match = /^(\d+)(s|m|h|d)$/u.exec(text);
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  let milliseconds: number;
  if (match) milliseconds = Number(match[1]) * units[match[2]!]!;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    const datePart = text.slice(0, 10),
      day = new Date(`${datePart}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== datePart)
      throw new TaskInputError("Expected a valid ISO-8601 timestamp.");
    milliseconds = Date.parse(text) - now.getTime();
  } else
    throw new TaskInputError(
      "Expected a duration such as 10m, 48h or 7d, or an ISO-8601 timestamp.",
    );
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(new Date(now.getTime() + milliseconds).getTime())
  )
    throw new TaskInputError(
      "The duration or timestamp must be in the future and within the supported date range.",
    );
  return milliseconds;
}

export async function readTaskFile(path: string): Promise<UploadFileInput> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new TaskInputError(`Task file ${JSON.stringify(path)} could not be read.`);
  }
  if (!details.isFile())
    throw new TaskInputError(
      `Task file ${JSON.stringify(path)} must be a regular file, not a directory.`,
    );
  const types: Record<string, UploadFileInput["contentType"]> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
  };
  const contentType = types[extname(path).toLowerCase()];
  if (!contentType)
    throw new TaskInputError("Task files must be images, PDF, ZIP, text, Markdown, JSON or CSV.");
  const bytes = await readFile(path);
  if (bytes.length < TASK_LIMITS.uploadBytesMin || bytes.length > TASK_LIMITS.uploadBytesMax)
    throw new TaskInputError("Task files must contain between 1 byte and 50 MiB.");
  return {
    fileName: basename(path),
    bytes: Uint8Array.from(bytes),
    contentType,
    purpose: "delivery",
  };
}

export function validTaskBrief(title: string, description: string): boolean {
  return (
    title.trim().length >= TASK_LIMITS.titleMin &&
    title.trim().length <= TASK_LIMITS.titleMax &&
    description.trim().length >= TASK_LIMITS.briefMin &&
    description.trim().length <= TASK_LIMITS.briefMax
  );
}
export type ProposalTerms = {
  title: string;
  description: string;
  amount: bigint;
  durationSeconds: number;
};
type ConfiguredDeployment = Extract<
  Awaited<ReturnType<TasksClient["deployment"]>>,
  { configured: true }
>;
export function proposalTerms(
  id: string,
  address: `0x${string}`,
  deployment: ConfiguredDeployment,
  terms: ProposalTerms,
): ProposeInput["signedPayload"] {
  return {
    version: "work-proposal-v1",
    workOrderId: id,
    providerAddress: address,
    pricingModel: "fixed",
    milestones: [
      {
        version: "work-milestone-terms-v1",
        title: terms.title,
        description: terms.description,
        acceptanceCriteria: ["Complete the task described in these terms."],
        workDurationSeconds: terms.durationSeconds,
        acceptanceWindowSeconds: 604800,
        budget: {
          network: deployment.network as `eip155:${number}`,
          asset: `${deployment.network}/erc20:${deployment.usdc}`,
          amountBaseUnits: terms.amount.toString(),
        },
        escrow: { protocol: "escrow-v1", contract: deployment.escrowContract },
        evidenceRules: { acceptedInputs: ["text", "private-file"], exactCommitRequired: false },
      },
    ],
  };
}
export function orderReceipts(
  order: GetOrderResponse["workOrder"],
  baseUrl: string,
): { receiptUrl: string; receiptUrlSource: "escrow" }[] {
  if (order.version !== "work-order-view-v1") return [];
  return order.milestones
    .filter(
      (m) =>
        ["released", "refunded"].includes(m.state) ||
        (m.escrowState === "resolved" && m.resolution !== null),
    )
    .map((m) => ({
      receiptUrl: `${baseUrl.replace(/\/+$/u, "")}/receipts/${m.escrowContract}`,
      receiptUrlSource: "escrow",
    }));
}

export const TASK_WATCH_STATES = [
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
] as const;
export function taskEventState(event: { type: string; payload: Record<string, unknown> }): string {
  return typeof event.payload.state === "string"
    ? event.payload.state.toLowerCase()
    : (event.type.split(".").at(-1)?.toLowerCase() ?? event.type.toLowerCase());
}
export function taskStateMatches(until: string, state: string): boolean {
  return until === state || (until === "paid" && state === "released");
}
export function nextTaskEvents(
  page: EventsResponse,
  cursor: number,
): { events: EventsResponse["events"]; nextCursor: number } {
  if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter < cursor)
    throw new TaskOperationError(
      "invalid_response",
      "The task event cursor regressed or is malformed.",
    );
  for (const event of page.events)
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
      throw new TaskOperationError("invalid_response", "A task event sequence is malformed.");
  const seen = new Set<number>();
  const events = [...page.events]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((event) => {
      if (event.sequence <= cursor || seen.has(event.sequence)) return false;
      seen.add(event.sequence);
      return true;
    });
  return {
    events,
    nextCursor: Math.max(cursor, page.nextAfter, ...page.events.map((e) => e.sequence)),
  };
}

export type TaskPolicy = {
  maxPerTaskUsd: number;
  approveAboveUsd: number;
  autoReleaseBelowUsd: number;
  source: "agent-profile" | "defaults";
};
export async function taskPolicyForWallet(args: {
  directory: string;
  wallet: string;
  schema: AgentProfileParser;
  warn?: (message: string) => void;
}): Promise<TaskPolicy> {
  let invalid = false;
  const profiles = await listAgentProfiles(args.directory, {
    schema: args.schema,
    ...(args.warn ? { warn: args.warn } : {}),
    onInvalid: () => {
      invalid = true;
    },
  });
  if (invalid) throw new TaskInputError("An invalid agent profile prevents task policy selection.");
  const matches = profiles.filter((profile) => profile.wallet === args.wallet);
  if (matches.length > 1)
    throw new TaskInputError(
      `More than one agent profile uses wallet ${args.wallet}; task policy is ambiguous.`,
    );
  const profile = matches[0];
  return profile
    ? {
        maxPerTaskUsd: profile.maxPerTaskUsd,
        approveAboveUsd: profile.approveAboveUsd,
        autoReleaseBelowUsd: profile.autoReleaseBelowUsd,
        source: "agent-profile",
      }
    : {
        maxPerTaskUsd: DEFAULT_MAX_PER_TASK_USD,
        approveAboveUsd: agentProfileSchema.shape.approveAboveUsd.parse(undefined),
        autoReleaseBelowUsd: DEFAULT_AUTO_RELEASE_BELOW_USD,
        source: "defaults",
      };
}

export type MoneySnapshot = {
  order: GetOrderResponse;
  escrowId: string;
  money: TaskMoney;
  readiness:
    | { ok: true; value: Awaited<ReturnType<TasksClient["deployment"]>> }
    | { ok: false; error: unknown };
};
export async function taskMoneySnapshot(
  client: TasksClient,
  orderId: string,
  escrowId?: string,
  options: { signInHint: string } = { signInHint: "" },
): Promise<MoneySnapshot> {
  const order = await taskRequest(
      "task money",
      "getOrder",
      () => client.getOrder(orderId),
      options,
    ),
    workOrder = order.workOrder;
  if (workOrder.id !== orderId || workOrder.version !== "work-order-view-v1")
    throw new TaskOperationError(
      "invalid_response",
      "A private task order matching the requested ID is required.",
    );
  const matches = escrowId
    ? workOrder.milestones.filter((m) => m.id === escrowId)
    : workOrder.milestones;
  if (matches.length !== 1)
    throw new TaskOperationError("invalid_response", "Select one task milestone by escrow ID.");
  const milestone = matches[0]!;
  if (milestone.workOrderId !== orderId)
    throw new TaskOperationError("invalid_response", "The milestone belongs to a different task.");
  let readiness: MoneySnapshot["readiness"];
  try {
    readiness = { ok: true, value: await client.deployment() };
  } catch (error) {
    readiness = { ok: false, error };
  }
  return {
    order,
    escrowId: milestone.id,
    money: taskMoney(milestone.amountBaseUnits, readiness.ok ? parseFeeBp(readiness.value) : null),
    readiness,
  };
}
export function cachedMoneyClient(client: TasksClient, snapshot: MoneySnapshot): TasksClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "getOrder")
        return async (id: string) => {
          if (id !== snapshot.order.workOrder.id)
            throw new Error("The cached task order does not match the requested ID.");
          return snapshot.order;
        };
      if (property === "deployment")
        return async () => {
          if (snapshot.readiness.ok) return snapshot.readiness.value;
          throw snapshot.readiness.error;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function fundingRefusalReason(
  error: unknown,
): "policy.perTask" | "policy.perDay" | undefined {
  if (!(
    error instanceof SpendCapError ||
    (error instanceof Error && error.name === "SpendCapError")
  ))
    return undefined;
  const code = "code" in error ? error.code : undefined;
  return code === "per_task_cap_exceeded"
    ? "policy.perTask"
    : code === "per_day_cap_exceeded"
      ? "policy.perDay"
      : undefined;
}

export type TaskOperationContext = {
  pending?: PendingTransactions;
  client: TasksClient;
  chain: TasksChain;
  baseUrl: string;
  randomUUID: () => string;
  signInHint: string;
};
export type TaskUnlock = () => Promise<{
  address: `0x${string}`;
  signMessage(message: string): Promise<`0x${string}`>;
}>;
