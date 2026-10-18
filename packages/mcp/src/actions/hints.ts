import type { MarketplaceDiscoveryPage } from "@vapi-network/core";

import type { CallToolResult } from "../tools/call.js";
import type { InspectToolResult } from "../tools/inspect.js";

export type HintSurface = "cli" | "mcp" | "agent";

type HintAction = "search" | "inspect" | "pay";

export function searchHints(
  page: MarketplaceDiscoveryPage,
  options: { includeOutage?: boolean; surface: HintSurface },
): string[] {
  const hints: string[] = [];
  const apis = page.items.filter((hit) => hit.kind === "api");
  const payable = apis.find(
    (hit) => hit.action.type === "invoke_api" && hit.execution.payable !== false,
  );
  if (payable) {
    hints.push(
      `Inspect before paying: ${renderAction(options.surface, "inspect", { id: payable.ref })}`,
    );
  }
  hints.push(
    ...apis
      .flatMap((hit) =>
        (hit.alternatives ?? []).map((alternative) => {
          const reason = alternative.reason === "cheaper" ? "cheaper healthy" : "healthier";
          return `${hit.ref} has a ${reason} alternative: ${alternative.ref}`;
        }),
      )
      .slice(0, 2),
  );
  const hiddenOutage = page.totals?.hiddenOutage ?? 0;
  if (options.includeOutage !== true && hiddenOutage > 0) {
    const count =
      hiddenOutage === 1 ? "1 listing in outage is" : `${hiddenOutage} listings in outage are`;
    hints.push(
      options.surface === "cli"
        ? `${count} hidden; add --include-outage to show them.`
        : `${count} hidden; call with includeOutage: true to show them.`,
    );
  }
  if (page.items.length === 0) {
    hints.push(
      `Broaden your search with: ${renderAction(options.surface, "search", { includeUnverified: true })}`,
    );
  }
  return hints.slice(0, 4);
}

export function inspectHints(
  result: InspectToolResult,
  options: { ref: string; surface: HintSurface },
): string[] {
  const hints: string[] = [];
  if (result.health?.state === "degraded" || result.health?.state === "outage") {
    hints.push(
      options.surface === "agent"
        ? `Recent checks show ${result.health.state}; find another API with: ${renderAction(options.surface, "search", {})}`
        : `Recent checks show ${result.health.state}; retry inspection later with: ${renderAction(options.surface, "inspect", { id: options.ref })}`,
    );
  }
  if (typeof result.payment?.protocol === "string") {
    hints.push(
      `This payment protocol is not supported; find another API with: ${renderAction(options.surface, "search", {})}`,
    );
    return hints;
  }
  const query = result.exampleRequest?.query;
  const hasQuery = query !== undefined && Object.keys(query).length > 0;
  const queryInBody = result.method === "GET" || result.method === "HEAD";
  let body: unknown = result.exampleRequest?.body;
  if (queryInBody && hasQuery) {
    // GET/HEAD --body objects are encoded as URL search parameters by callService.
    body = { ...(isRecord(body) ? body : {}), ...query };
  }
  if (body === undefined) body = requiredBody(result.requestSchema);
  if (options.surface === "agent" && !queryInBody && hasQuery) {
    hints.push(
      `This example needs URL query parameters; find another API with: ${renderAction(options.surface, "search", {})}`,
    );
  } else if (
    options.surface === "agent" &&
    (exactPrice(result.price) === undefined || result.method === null)
  ) {
    hints.push(
      `Find an API with a published price and method: ${renderAction(options.surface, "search", {})}`,
    );
  } else {
    const queryUrl = !queryInBody && hasQuery ? new URL(result.url) : undefined;
    if (queryUrl) {
      for (const [key, value] of Object.entries(query!)) queryUrl.searchParams.set(key, value);
    }
    const direct =
      queryUrl !== undefined || result.network !== undefined || /^https?:\/\//u.test(options.ref);
    hints.push(
      `Pay with: ${renderAction(
        options.surface,
        "pay",
        {
          ...(queryUrl === undefined ? { id: options.ref } : { url: queryUrl.href }),
          ...(!direct && result.name ? { endpoint: result.name } : {}),
          ...(direct ? { method: result.method ?? "<method>" } : {}),
          body,
          ...(queryUrl !== undefined && result.requestContentType !== undefined
            ? { contentType: result.requestContentType }
            : {}),
          ...(queryUrl !== undefined && result.payment?.network !== undefined
            ? { network: result.payment.network }
            : {}),
          ...(queryUrl !== undefined && result.payment?.payTo !== undefined
            ? { expectedPayTo: result.payment.payTo }
            : {}),
        },
        result.price,
      )}`,
    );
  }
  return hints;
}

export function payHints(
  result: Pick<CallToolResult, "status"> & {
    outcome?: string;
    receiptId?: string;
    wallet?: string;
  },
  options: { ref?: string; url?: string; surface: HintSurface; receiptId?: string },
): string[] {
  const hints: string[] = [];
  const settlementUnknown = result.outcome === "settlement_unknown";
  if (result.status >= 200 && result.status < 300 && !settlementUnknown) {
    if (options.surface === "cli") {
      hints.push(
        `Receipt saved; review it with: vapi receipts --limit 1${result.wallet ? ` --account ${shellWord(result.wallet)}` : ""}`,
      );
    } else if (options.surface === "mcp") {
      hints.push(
        `Receipt saved; review it with: receipts.list ${JSON.stringify({ limit: 1, ...(result.wallet ? { wallet: result.wallet } : {}) })}`,
      );
    } else if (options.ref) {
      // Receipts are not exposed as an agent-loop action.
      hints.push(
        `Review the request contract with: ${renderAction(options.surface, "inspect", { id: options.ref })}`,
      );
    }
    return hints;
  }
  if (options.ref) {
    hints.push(
      `The provider answered ${result.status}; check the request contract with: ${renderAction(options.surface, "inspect", { id: options.ref })}`,
    );
  }
  const receiptId = options.receiptId ?? result.receiptId;
  // Settlement lookup is a CLI-only operation; no MCP or loop tool resumes payments.
  if ((result.status === 402 || settlementUnknown) && receiptId && options.surface === "cli") {
    hints.push(`Check settlement with: vapi pay --resume ${shellWord(receiptId)}`);
  }
  return hints;
}

function renderAction(
  surface: HintSurface,
  action: HintAction,
  args: {
    id?: string;
    url?: string;
    endpoint?: string;
    method?: string;
    body?: unknown;
    contentType?: string;
    network?: string;
    expectedPayTo?: string;
    includeUnverified?: boolean;
  },
  price?: string,
): string {
  if (surface === "agent") {
    // The loop exposes a smaller contract than MCP, including JSON-encoded bodies.
    const loopArgs =
      action === "search"
        ? { query: "api", network: null, includeOutage: false }
        : action === "inspect"
          ? { ref: args.id }
          : { ref: args.id, body: JSON.stringify(args.body), max_usd: exactPrice(price ?? "") };
    return `call_${action} ${JSON.stringify(loopArgs)}`;
  }
  if (surface === "mcp") return `call.${action} ${JSON.stringify(args)}`;
  if (action === "search") return "vapi search --include-unverified";
  const command = `vapi ${action} ${shellWord(args.url ?? args.id ?? "")}`;
  if (action === "inspect") return command;
  const endpoint = args.endpoint ? ` --endpoint ${shellWord(args.endpoint)}` : "";
  const method = args.method ? ` --method ${shellWord(args.method)}` : "";
  const headers = args.contentType ? ` --content-type ${shellWord(args.contentType)}` : "";
  const network = args.network ? ` --network ${shellWord(args.network)}` : "";
  const payee = args.expectedPayTo ? ` --expected-pay-to ${shellWord(args.expectedPayTo)}` : "";
  return `${command}${endpoint}${method} --body ${shellQuote(args.body === "<json>" ? "<json>" : (JSON.stringify(args.body) ?? "<json>"))}${headers}${network}${payee}`;
}

function exactPrice(price: string): number | undefined {
  if (!/^\$(0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(price.trim())) return undefined;
  const value = Number(price.trim().slice(1));
  return Number.isFinite(value) ? value : undefined;
}

function requiredBody(schema: unknown): unknown {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return "<json>";
  const names = schema.required.filter((name): name is string => typeof name === "string");
  return names.length > 0 ? Object.fromEntries(names.map((name) => [name, "<value>"])) : "<json>";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellWord(value: string): string {
  return /^[a-zA-Z0-9_./:@%-]+$/u.test(value) ? value : shellQuote(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
