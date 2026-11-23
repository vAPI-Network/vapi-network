import { describe, expect, it, vi } from "vitest";

import { runCli, type CliIo } from "./cli.js";

const searchEnvelope = {
  result: {
    content: [
      {
        type: "text",
        text: "Title: Quickstart\nLink: https://docs.vapinetwork.ai/quickstart\nContent: Start here and configure the client.",
      },
    ],
  },
  jsonrpc: "2.0",
  id: 1,
};

describe("vapi docs", () => {
  it.each([
    {
      name: "ask",
      args: ["docs", "How do I start?"],
      response:
        "Use the quickstart.\n\n# Sources:\n- [Quickstart](https://docs.vapinetwork.ai/quickstart)\n",
      human:
        "Use the quickstart.\n\nSources:\n- Quickstart: https://docs.vapinetwork.ai/quickstart",
      json: {
        answer: "Use the quickstart.",
        sources: [{ title: "Quickstart", url: "https://docs.vapinetwork.ai/quickstart" }],
      },
    },
    {
      name: "search",
      args: ["docs", "search", "setup"],
      response: JSON.stringify(searchEnvelope),
      human:
        "Quickstart\nhttps://docs.vapinetwork.ai/quickstart\nStart here and configure the client.",
      json: {
        results: [
          {
            title: "Quickstart",
            url: "https://docs.vapinetwork.ai/quickstart",
            excerpt: "Start here and configure the client.",
          },
        ],
      },
    },
    {
      name: "read",
      args: ["docs", "read", "/quickstart"],
      response: "# Quickstart\n\nInstall vAPI.",
      human: "# Quickstart\n\nInstall vAPI.",
      json: {
        url: "https://docs.vapinetwork.ai/quickstart.md",
        markdown: "# Quickstart\n\nInstall vAPI.",
      },
    },
  ])(
    "prints $name in human and JSON modes before init",
    async ({ args, response, human, json }) => {
      const humanIo = capturedIo();
      const humanFetch = vi.fn<typeof fetch>(async (url) =>
        new URL(String(url)).pathname === "/mcp"
          ? new Response("Not Found", { status: 404 })
          : new Response(response),
      );
      expect(await runCli(args, humanIo.io, { fetchImpl: humanFetch, env: {} })).toBe(0);
      expect(humanIo.stdout).toEqual([human]);
      expect(humanIo.stderr).toEqual([]);

      const jsonIo = capturedIo();
      const jsonFetch = vi.fn<typeof fetch>(async (url) =>
        new URL(String(url)).pathname === "/mcp"
          ? new Response("Not Found", { status: 404 })
          : new Response(response),
      );
      expect(await runCli([...args, "--json"], jsonIo.io, { fetchImpl: jsonFetch, env: {} })).toBe(
        0,
      );
      expect(jsonIo.stdout).toHaveLength(1);
      expect(JSON.parse(jsonIo.stdout[0]!)).toEqual(json);
      expect(jsonIo.stderr).toEqual([]);
    },
  );

  it.each([false, true])(
    "prints search sections for ask on the new site (JSON: %s)",
    async (json) => {
      const io = capturedIo();
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (new URL(String(input)).pathname === "/readme.md") {
          return new Response("Not Found", { status: 404 });
        }
        return Response.json({
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify([
                  { title: "Call", url: "/call/", heading: "", snippet: "Call APIs." },
                ]),
              },
            ],
            isError: false,
          },
          jsonrpc: "2.0",
          id: 1,
        });
      });
      const args = ["docs", "How do I call APIs?", ...(json ? ["--json"] : [])];

      expect(await runCli(args, io.io, { fetchImpl, env: {} })).toBe(0);
      const answer =
        "These are the closest sections of the docs; the new docs site has no assistant.\n\n" +
        "- [Call](https://docs.vapinetwork.ai/call/): Call APIs.";
      if (json) {
        expect(JSON.parse(io.stdout[0]!)).toEqual({
          answer,
          sources: [{ title: "Call", url: "https://docs.vapinetwork.ai/call/" }],
        });
      } else {
        expect(io.stdout).toEqual([
          `${answer}\n\nSources:\n- Call: https://docs.vapinetwork.ai/call/`,
        ]);
      }
      expect(io.stderr).toEqual([]);
      expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/readme.md",
        "/mcp",
      ]);
    },
  );
});

function capturedIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}
