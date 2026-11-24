import { readFile } from "node:fs/promises";

import { getDefaultConfig } from "@vapi-network/core";
import { describe, expect, it } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer } from "./server.js";

/**
 * A tool an agent can call but the MCP guide never names is a tool nobody knows
 * how to ask for. Registration is the source of truth; docs/mcp.md follows it.
 */

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;

/** The MCP guide, which the repository README links as the tool list. */
const guide = await readFile(new URL("../../../docs/mcp.md", import.meta.url), "utf8");

async function registeredToolNames(): Promise<string[]> {
  const server = createVapiServer({
    account: privateKeyToAccount(PRIVATE_KEY),
    config: getDefaultConfig(),
    fetchImpl: () => Promise.reject(new Error("The documentation test makes no network call.")),
  });
  const { tools } = await server.listTools();
  await server.close();
  return tools.map((tool) => tool.name);
}

describe("every registered MCP tool is documented", () => {
  it("names each tool in docs/mcp.md", async () => {
    const undocumented = (await registeredToolNames()).filter(
      (name) => !guide.includes(`\`${name}\``),
    );

    expect(undocumented).toEqual([]);
  });

  it("lists each deprecated alias under a Deprecated heading", async () => {
    const aliases = (await registeredToolNames()).filter((name) => !name.includes("."));
    const deprecated = guide.slice(guide.indexOf("#### Deprecated tool aliases"));

    expect(aliases).not.toEqual([]);
    for (const alias of aliases) expect(deprecated).toContain(`\`${alias}\``);
  });
});
