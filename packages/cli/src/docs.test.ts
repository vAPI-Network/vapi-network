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
      const humanFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(response));
      expect(await runCli(args, humanIo.io, { fetchImpl: humanFetch, env: {} })).toBe(0);
      expect(humanIo.stdout).toEqual([human]);
      expect(humanIo.stderr).toEqual([]);

      const jsonIo = capturedIo();
      const jsonFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(response));
      expect(await runCli([...args, "--json"], jsonIo.io, { fetchImpl: jsonFetch, env: {} })).toBe(
        0,
      );
      expect(jsonIo.stdout).toHaveLength(1);
      expect(JSON.parse(jsonIo.stdout[0]!)).toEqual(json);
      expect(jsonIo.stderr).toEqual([]);
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
