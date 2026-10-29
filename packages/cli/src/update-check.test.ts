import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getVapiPaths } from "@vapi-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkForUpdate, runCliWithUpdateCheck } from "./update-check.js";
import { CLI_VERSION } from "./version.js";

const DAY = 24 * 60 * 60 * 1_000;
const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vapi-update-check-"));
  homes.push(home);
  return home;
}

function response(body: unknown, ok = true): Response {
  return Response.json(body, { status: ok ? 200 : 503 });
}

function enabled(home: string, fetchImpl: typeof fetch, now = 1_800_000_000_000) {
  return { home, fetchImpl, nowMs: () => now, env: {}, argv: ["version"], stderrIsTTY: true };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("checkForUpdate", () => {
  it("uses a successful cache for a day and refreshes it when it expires", async () => {
    const home = await tempHome();
    const now = 1_800_000_000_000;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ version: "0.12.0" }));

    expect(await checkForUpdate(enabled(home, fetchImpl, now))).toContain("vapi-network 0.12.0");
    expect(await checkForUpdate(enabled(home, fetchImpl, now + DAY - 1))).toContain(
      "vapi-network 0.12.0",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockResolvedValueOnce(response({ version: "0.13.0" }));
    expect(await checkForUpdate(enabled(home, fetchImpl, now + DAY))).toContain(
      "vapi-network 0.13.0",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("records failed attempts and makes at most one request in 24 hours", async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const now = 1_800_000_000_000;

    expect(await checkForUpdate(enabled(home, fetchImpl, now))).toBeUndefined();
    expect(await checkForUpdate(enabled(home, fetchImpl, now + DAY - 1))).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(getVapiPaths(home).updateCheck, "utf8"))).toEqual({
      checkedAt: now,
      latest: CLI_VERSION,
    });
  });

  it.each([
    ["a non-ok response", response({}, false)],
    ["an invalid JSON body", new Response("{")],
    ["an invalid response shape", response({ version: 10 })],
  ])("silently ignores %s", async (_label, registryResponse) => {
    const home = await tempHome();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(registryResponse);
    expect(await checkForUpdate(enabled(home, fetchImpl))).toBeUndefined();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([
    ["invalid JSON", "{"],
    [
      "invalid cached version",
      JSON.stringify({ checkedAt: 1_800_000_000_000, latest: "1.2.3;owned" }),
    ],
    ["invalid timestamp", JSON.stringify({ checkedAt: "today", latest: "0.12.0" })],
  ])("recovers from %s", async (_label, cache) => {
    const home = await tempHome();
    await writeFile(getVapiPaths(home).updateCheck, cache);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ version: "0.12.0" }));

    expect(await checkForUpdate(enabled(home, fetchImpl))).toContain("vapi-network 0.12.0");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["same", CLI_VERSION],
    ["older", "0.9.3"],
    ["prerelease of the same core", `${CLI_VERSION}-rc.1`],
    ["command-like invalid semver", "0.11.0; touch /tmp/owned"],
    ["leading-zero semver", "00.11.0"],
    ["invalid prerelease", "0.11.0-01"],
  ])("does not announce a %s registry version", async (_label, version) => {
    const home = await tempHome();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ version }));
    expect(await checkForUpdate(enabled(home, fetchImpl))).toBeUndefined();
  });

  it("compares numeric semver components instead of lexically", async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ version: "0.12.0" }));
    expect(await checkForUpdate(enabled(home, fetchImpl))).toBe(
      `vapi-network 0.12.0 is available (you have ${CLI_VERSION}). Update: npm i -g vapi-network@latest`,
    );
  });

  it("checks for updates when installing an MCP entry", async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ version: "0.12.0" }));
    expect(
      await checkForUpdate({ ...enabled(home, fetchImpl), argv: ["mcp", "install", "codex"] }),
    ).toContain("vapi-network 0.12.0");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["non-TTY stderr", { stderrIsTTY: false }],
    ["JSON output", { argv: ["version", "--json"] }],
    ["MCP command", { argv: ["mcp"] }],
    ["Claude launcher", { argv: ["claude", "--own"] }],
    ["Codex launcher", { argv: ["codex", "resume", "--last"] }],
    ["CI value", { env: { CI: "true" } }],
    ["empty CI value", { env: { CI: "" } }],
    ["explicit opt-out", { env: { VAPI_NO_UPDATE_CHECK: "1" } }],
  ])("does no I/O for %s", async (_label, override) => {
    const home = await tempHome();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await checkForUpdate({ ...enabled(home, fetchImpl), ...override })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(getVapiPaths(home).updateCheck, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["fetch", "body"])("times out when the %s promise ignores abort", async (stage) => {
    vi.useFakeTimers();
    const home = await tempHome();
    let signal: AbortSignal | undefined;
    const never = new Promise<never>(() => undefined);
    let markFetchReached!: () => void;
    const fetchReached = new Promise<void>((resolve) => {
      markFetchReached = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      markFetchReached();
      if (stage === "fetch") return never;
      return { ok: true, json: () => never } as unknown as Response;
    });
    const result = checkForUpdate(enabled(home, fetchImpl));
    await fetchReached;
    await vi.advanceTimersByTimeAsync(1_499);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });
});

describe("runCliWithUpdateCheck", () => {
  it("prints command output before the update notice and preserves the exit code", async () => {
    const home = await tempHome();
    const events: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ version: "0.12.0" }));

    const code = await runCliWithUpdateCheck(
      ["version"],
      {
        stdout: (message) => events.push(`stdout:${message}`),
        stderr: (message) => events.push(`stderr:${message}`),
      },
      {},
      enabled(home, fetchImpl),
    );

    expect(code).toBe(0);
    expect(events).toEqual([
      `stdout:${CLI_VERSION}`,
      `stderr:vapi-network 0.12.0 is available (you have ${CLI_VERSION}). Update: npm i -g vapi-network@latest`,
    ]);
  });

  it("preserves a command failure exit code while completing the check", async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ version: CLI_VERSION }));
    const stderr = vi.fn();
    expect(
      await runCliWithUpdateCheck(
        ["not-a-command"],
        { stdout: vi.fn(), stderr },
        {},
        enabled(home, fetchImpl),
      ),
    ).toBe(2);
    expect(stderr).toHaveBeenCalledWith('Unknown command "not-a-command". Run vapi help.');
  });
});
