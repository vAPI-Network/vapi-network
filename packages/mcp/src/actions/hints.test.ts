import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  marketplaceDiscoveryPageSchema,
  type MarketplaceDiscoveryPage,
  type MarketplaceHit,
} from "@vapi-network/core";
import { describe, expect, it } from "vitest";

import type { InspectToolResult } from "../tools/inspect.js";
import { callPayInputSchema } from "./call.js";
import { inspectHints, payHints, searchHints, type HintSurface } from "./hints.js";

const surfaces: HintSurface[] = ["cli", "mcp", "agent"];
const inspected: InspectToolResult = {
  name: "forecast",
  method: "POST",
  url: "https://weather.example/forecast",
  price: "$0.01",
  description: "Read a forecast.",
  verification: "verified",
  payment: null,
  exampleRequest: { body: { city: "Amsterdam" } },
};

function api(
  ref: string,
  alternatives?: Array<{ ref: string; reason: "cheaper" | "healthier" }>,
): Extract<MarketplaceHit, { kind: "api" }> {
  return {
    ref,
    kind: "api",
    verification: "verified",
    provenance: "self_listed",
    execution: { mode: "direct" },
    card: { title: ref, summary: "Forecasts.", badges: [], facts: [] },
    action: { type: "invoke_api", href: `/call/${ref}` },
    ...(alternatives ? { alternatives } : {}),
  };
}

const work: MarketplaceHit = {
  ref: "forecast-work",
  kind: "service_offer",
  verification: "none",
  card: { title: "Forecast work", summary: "Hire a forecaster.", badges: [], facts: [] },
  action: { type: "start_engagement", href: "/work/forecast" },
};

function page(items: MarketplaceHit[], hiddenOutage?: number): MarketplaceDiscoveryPage {
  return {
    protocol: "vapi.marketplace.discovery/1",
    items,
    nextCursor: null,
    unavailableKinds: [],
    rankingVersion: "marketplace-ranking-v2",
    ...(hiddenOutage === undefined ? {} : { totals: { hiddenOutage } }),
  };
}

describe("search hints", () => {
  it.each(surfaces)("skips the unpayable MPP fixture ahead of payable APIs for %s", (surface) => {
    const fixture = marketplaceDiscoveryPageSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../sources/src/__fixtures__/vapi-marketplace-mpp-unverified.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    const options = { surface, includeOutage: true };
    expect(searchHints(fixture, options)).toEqual([]);
    expect(
      searchHints({ ...fixture, items: [...fixture.items, api("weather")] }, options)[0],
    ).toContain("weather");
    expect(searchHints({ ...fixture, items: [api("older-registry")] }, options)[0]).toContain(
      "older-registry",
    );
  });
  it.each(surfaces)(
    "prioritizes payable APIs and caps alternatives and total hints for %s",
    (surface) => {
      const result = page(
        [
          work,
          api("weather", [
            { ref: "budget-weather", reason: "cheaper" },
            { ref: "reliable-weather", reason: "healthier" },
          ]),
          api("other", [{ ref: "ignored", reason: "cheaper" }]),
        ],
        2,
      );
      const expected = {
        cli: [
          "Inspect before paying: vapi inspect weather",
          "weather has a cheaper healthy alternative: budget-weather",
          "weather has a healthier alternative: reliable-weather",
          "2 listings in outage are hidden; add --include-outage to show them.",
        ],
        mcp: [
          'Inspect before paying: call.inspect {"id":"weather"}',
          "weather has a cheaper healthy alternative: budget-weather",
          "weather has a healthier alternative: reliable-weather",
          "2 listings in outage are hidden; call with includeOutage: true to show them.",
        ],
        agent: [
          'Inspect before paying: call_inspect {"ref":"weather"}',
          "weather has a cheaper healthy alternative: budget-weather",
          "weather has a healthier alternative: reliable-weather",
          "2 listings in outage are hidden; call with includeOutage: true to show them.",
        ],
      };
      expect(searchHints(result, { surface })).toEqual(expected[surface]);
    },
  );

  it.each(surfaces)("handles empty and non-API pages for %s", (surface) => {
    const broad = {
      cli: "Broaden your search with: vapi search --include-unverified",
      mcp: 'Broaden your search with: call.search {"includeUnverified":true}',
      agent:
        'Broaden your search with: call_search {"query":"api","network":null,"includeOutage":false}',
    };
    const hidden =
      surface === "cli"
        ? "1 listing in outage is hidden; add --include-outage to show them."
        : "1 listing in outage is hidden; call with includeOutage: true to show them.";
    expect(searchHints(page([], 1), { surface })).toEqual([hidden, broad[surface]]);
    expect(searchHints(page([], 1), { surface, includeOutage: true })).toEqual([broad[surface]]);
    // An older registry sends no totals, so nothing is claimed to be hidden.
    expect(searchHints(page([]), { surface })).toEqual([broad[surface]]);
    expect(searchHints(page([work]), { surface })).toEqual([]);
    expect(searchHints(page([api("weather")]), { surface })).toHaveLength(1);
    expect(searchHints(page([api("weather")], 0), { surface })).toHaveLength(1);
    expect(searchHints(page([api("weather")], 3), { surface })).toHaveLength(2);
  });

  it("inspects an indexed API whose payable action is invoke_api", () => {
    const indexed: MarketplaceHit = {
      ...api("external"),
      kind: "api",
      provenance: "indexed",
      execution: {
        mode: "direct",
        url: "https://external.example/forecast",
        method: "GET",
        network: "eip155:8453",
      },
    };
    expect(searchHints(page([indexed]), { surface: "mcp", includeOutage: true })).toEqual([
      'Inspect before paying: call.inspect {"id":"external"}',
    ]);
  });
});

describe("inspect hints", () => {
  it.each(surfaces)("does not suggest paying an unsupported protocol for %s", (surface) => {
    const hints = inspectHints(
      {
        ...inspected,
        payment: {
          protocol: "mpp",
          intent: "charge",
          method: "tempo",
          checkedAt: "2026-08-19T10:30:00.000Z",
        },
      },
      { ref: "mpp", surface },
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("not supported");
    expect(hints[0]).toContain(
      surface === "cli" ? "vapi search" : surface === "mcp" ? "call.search" : "call_search",
    );
  });
  it.each(surfaces)("renders the example body and named endpoint for %s", (surface) => {
    const expected = {
      cli: ['Pay with: vapi pay weather --endpoint forecast --body \'{"city":"Amsterdam"}\''],
      mcp: [
        'Pay with: call.pay {"id":"weather","endpoint":"forecast","body":{"city":"Amsterdam"}}',
      ],
      agent: [
        'Pay with: call_pay {"ref":"weather","body":"{\\"city\\":\\"Amsterdam\\"}","max_usd":0.01}',
      ],
    };
    expect(inspectHints(inspected, { ref: "weather", surface })).toEqual(expected[surface]);
  });

  it.each(surfaces)(
    "warns only for degraded/outage and puts the warning first for %s",
    (surface) => {
      for (const state of ["degraded", "outage", "healthy", "unknown"] as const) {
        const result = inspectHints(
          {
            ...inspected,
            health: { state, uptime7d: null, latencyP50Ms: null, latencyP95Ms: null, checks7d: 0 },
          },
          { ref: "weather", surface },
        );
        if (state === "degraded" || state === "outage") {
          expect(result).toHaveLength(2);
          expect(result[0]).toMatch(
            new RegExp(
              `^Recent checks show ${state}; ${surface === "agent" ? "find another API" : "retry inspection later"} with:`,
            ),
          );
          expect(result[1]).toMatch(/^Pay with:/);
        } else {
          expect(result).toHaveLength(1);
          expect(result[0]).toMatch(/^Pay with:/);
        }
      }
    },
  );

  it.each(surfaces)(
    "builds required property placeholders or a JSON placeholder for %s",
    (surface) => {
      const withoutExample = { ...inspected, exampleRequest: undefined };
      const required = inspectHints(
        { ...withoutExample, name: "", requestSchema: { required: ["city", "date"] } },
        { ref: "weather", surface },
      );
      const fallback = inspectHints(withoutExample, { ref: "weather", surface });
      if (surface === "cli") {
        expect(required).toEqual([
          'Pay with: vapi pay weather --body \'{"city":"<value>","date":"<value>"}\'',
        ]);
        expect(fallback).toEqual([
          "Pay with: vapi pay weather --endpoint forecast --body '<json>'",
        ]);
      } else if (surface === "mcp") {
        expect(required).toEqual([
          'Pay with: call.pay {"id":"weather","body":{"city":"<value>","date":"<value>"}}',
        ]);
        expect(fallback).toEqual([
          'Pay with: call.pay {"id":"weather","endpoint":"forecast","body":"<json>"}',
        ]);
      } else {
        expect(required).toEqual([
          'Pay with: call_pay {"ref":"weather","body":"{\\"city\\":\\"<value>\\",\\"date\\":\\"<value>\\"}","max_usd":0.01}',
        ]);
        expect(fallback).toEqual([
          'Pay with: call_pay {"ref":"weather","body":"\\"<json>\\"","max_usd":0.01}',
        ]);
      }
    },
  );

  it.each(surfaces)("sends GET/HEAD query examples through body for %s", (surface) => {
    for (const method of ["GET", "HEAD"]) {
      const result = inspectHints(
        { ...inspected, method, exampleRequest: { query: { city: "Amsterdam" } } },
        { ref: "weather", surface },
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toContain(
        surface === "cli"
          ? '--body \'{"city":"Amsterdam"}\''
          : surface === "mcp"
            ? '"body":{"city":"Amsterdam"}'
            : '"body":"{\\"city\\":\\"Amsterdam\\"}"',
      );
      expect(result[0]).not.toContain("--query");
    }
  });

  it.each(["POST", "PUT", "PATCH"])(
    "includes query, method and body in one executable %s action",
    (method) => {
      const query = { units: "metric", city: "New York & Paris" };
      const body = { city: "Amsterdam" };
      const result = {
        ...inspected,
        method,
        url: "https://weather.example/forecast?key=existing&units=old",
        exampleRequest: { query, body },
      };
      const url =
        "https://weather.example/forecast?key=existing&units=metric&city=New+York+%26+Paris";
      const [mcpHint] = inspectHints(result, { ref: "weather", surface: "mcp" });
      expect(
        callPayInputSchema.parse(JSON.parse(mcpHint!.slice("Pay with: call.pay ".length))),
      ).toEqual({ url, method, body });
      const [cliHint] = inspectHints(result, { ref: "weather", surface: "cli" });
      const shell = spawnSync(
        "/bin/sh",
        ["-c", `vapi() { printf '%s\\0' "$@"; }\n${cliHint!.slice("Pay with: ".length)}`],
        { encoding: "utf8" },
      );
      expect(shell.status).toBe(0);
      expect(shell.stdout.split("\0")).toEqual([
        "pay",
        url,
        "--method",
        method,
        "--body",
        JSON.stringify(body),
        "",
      ]);
      expect(inspectHints(result, { ref: "weather", surface: "agent" })[0]).toContain(
        "call_search",
      );
    },
  );

  it("keeps request content type and registered payment constraints on a query URL", () => {
    const payTo = "0x0000000000000000000000000000000000000001";
    const [hint] = inspectHints(
      {
        ...inspected,
        requestContentType: "application/json",
        payment: {
          scheme: "exact",
          network: "eip155:8453",
          asset: payTo,
          payTo,
          checkedAt: "2026-08-19T10:30:00.000Z",
        },
        exampleRequest: { query: { units: "metric" }, body: { city: "Amsterdam" } },
      },
      { ref: "weather", surface: "mcp" },
    );
    expect(
      callPayInputSchema.parse(JSON.parse(hint!.slice("Pay with: call.pay ".length))),
    ).toMatchObject({
      url: "https://weather.example/forecast?units=metric",
      method: "POST",
      body: { city: "Amsterdam" },
      contentType: "application/json",
      network: "eip155:8453",
      expectedPayTo: payTo,
    });
  });

  it("shell-escapes single quotes and shell syntax inside JSON", () => {
    expect(
      inspectHints(
        { ...inspected, exampleRequest: { body: { text: "O'Brien $(touch /tmp/nope) `whoami`" } } },
        { ref: "weather", surface: "cli" },
      ),
    ).toEqual([
      "Pay with: vapi pay weather --endpoint forecast --body '{\"text\":\"O'\\''Brien $(touch /tmp/nope) `whoami`\"}'",
    ]);
  });

  it("keeps the CLI body as one literal shell argument", () => {
    const body = { text: "O'Brien $(printf injected) `printf injected`" };
    const [hint] = inspectHints(
      { ...inspected, exampleRequest: { body } },
      { ref: "weather", surface: "cli" },
    );
    const command = hint!.slice("Pay with: ".length);
    const shell = spawnSync("/bin/sh", ["-c", `vapi() { printf '%s\\0' "$@"; }\n${command}`], {
      encoding: "utf8",
    });
    expect(shell.status).toBe(0);
    expect(shell.stderr).toBe("");
    expect(shell.stdout.split("\0")).toEqual([
      "pay",
      "weather",
      "--endpoint",
      "forecast",
      "--body",
      JSON.stringify(body),
      "",
    ]);
  });

  it.each(surfaces)("omits endpoint selectors for mirrored API titles on %s", (surface) => {
    const result = inspectHints(
      { ...inspected, name: "External weather API", network: "eip155:8453" },
      { ref: "external", surface },
    );
    expect(result[0]).not.toMatch(/--endpoint|"endpoint"/);
    expect(result[0]).toContain(
      surface === "cli"
        ? "--method POST"
        : surface === "mcp"
          ? '"method":"POST"'
          : '"ref":"external"',
    );
  });

  it("requires a chosen method for mirrored APIs without a published method", () => {
    expect(
      inspectHints(
        { ...inspected, network: "eip155:8453", method: null },
        { ref: "external", surface: "cli" },
      )[0],
    ).toContain("--method '<method>'");
  });

  it("does not invent an agent price or method when one is unknown", () => {
    for (const result of [
      { ...inspected, price: "See live x402 quote" },
      { ...inspected, method: null },
    ]) {
      expect(inspectHints(result, { ref: "weather", surface: "agent" })).toEqual([
        'Find an API with a published price and method: call_search {"query":"api","network":null,"includeOutage":false}',
      ]);
    }
  });

  it.each([null, false, 0, "", []])("preserves the explicit example body %j", (body) => {
    expect(
      inspectHints({ ...inspected, exampleRequest: { body } }, { ref: "weather", surface: "mcp" }),
    ).toEqual([
      `Pay with: call.pay {"id":"weather","endpoint":"forecast","body":${JSON.stringify(body)}}`,
    ]);
  });
});

describe("pay hints", () => {
  it("keeps receipt review scoped to the account that paid", () => {
    expect(payHints({ status: 200, wallet: "secondary" }, { surface: "cli" })).toEqual([
      "Receipt saved; review it with: vapi receipts --limit 1 --account secondary",
    ]);
    expect(payHints({ status: 200, wallet: "secondary" }, { surface: "mcp" })).toEqual([
      'Receipt saved; review it with: receipts.list {"limit":1,"wallet":"secondary"}',
    ]);
  });
  it.each(surfaces)("uses an available next action after success for %s", (surface) => {
    const expected = {
      cli: ["Receipt saved; review it with: vapi receipts --limit 1"],
      mcp: ['Receipt saved; review it with: receipts.list {"limit":1}'],
      agent: ['Review the request contract with: call_inspect {"ref":"weather"}'],
    };
    for (const status of [200, 204, 299]) {
      expect(payHints({ status }, { ref: "weather", surface })).toEqual(expected[surface]);
    }
  });

  it.each(surfaces)("inspects the contract after non-2xx for %s", (surface) => {
    const expected = {
      cli: ["The provider answered 500; check the request contract with: vapi inspect weather"],
      mcp: [
        'The provider answered 500; check the request contract with: call.inspect {"id":"weather"}',
      ],
      agent: [
        'The provider answered 500; check the request contract with: call_inspect {"ref":"weather"}',
      ],
    };
    expect(payHints({ status: 500 }, { ref: "weather", surface })).toEqual(expected[surface]);
  });

  it.each(surfaces)(
    "never invents a listing ref or resume id for URL-only calls on %s",
    (surface) => {
      expect(payHints({ status: 402 }, { url: "https://api.example/paid", surface })).toEqual([]);
      expect(payHints({ status: 500 }, { surface })).toEqual([]);
      expect(
        payHints({ status: 200 }, { url: "https://api.example/paid", surface }).join(" "),
      ).not.toContain("undefined");
    },
  );

  it.each(surfaces)(
    "offers settlement lookup only when supported and a receipt id is exposed for %s",
    (surface) => {
      const options = { surface, url: "https://api.example/paid" };
      const expected =
        surface === "cli" ? ["Check settlement with: vapi pay --resume receipt-123"] : [];
      expect(payHints({ status: 402, receiptId: "receipt-123" }, options)).toEqual(expected);
      expect(
        payHints(
          { status: 200, outcome: "settlement_unknown" },
          { ...options, receiptId: "receipt-123" },
        ),
      ).toEqual(expected);
      expect(payHints({ status: 402 }, options)).toEqual([]);
      expect(payHints({ status: 500, receiptId: "receipt-123" }, options)).toEqual([]);
    },
  );
});
